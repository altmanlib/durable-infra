import { type Kysely, sql } from "kysely";

import type { UsageCounters } from "../usage.ts";
import type { InsightsSchema } from "./schema.ts";

/** Width of a spend bucket. Every day boundary of a time zone in use falls on a multiple of it, so a bucket never straddles two days. */
export const BUCKET_MS = 15 * 60 * 1000;

/** Spend to add to one bucket. */
export type SpendDelta = { bucket: number; kind: "model" | "tool"; name: string; usage: UsageCounters };

/** Spend of one source in one bucket, summed over the keys asked for. */
export type BucketSpend = { bucket: number; kind: "model" | "tool"; name: string; usage: UsageCounters };

/** What counting a conversation's new entries changes, written together. */
export type LedgerCommit = {
  conversationId: number;
  /** The conversation's channel key; empty when it has none. */
  key: string;
  /** The newest entry counted so far. */
  lastEntryId: number;
  spend: readonly SpendDelta[];
  /** Present when the conversation is the one its key points at and belongs in the listing. */
  listing?: { lastActiveAt: number | undefined };
};

/** One key's row in the listing. */
export type ListingRow = { key: string; conversationId: number; lastActiveAt: number | undefined };

/** Where a page of the listing starts: after the row with this activity time and key. */
export type ListingPosition = { lastActiveAt: number | undefined; key: string };

/** The ledger's tables: counted spend, how far each conversation is counted, and the listing. */
export class InsightsStore {
  readonly #db: Kysely<InsightsSchema>;

  constructor(db: Kysely<InsightsSchema>) {
    this.#db = db;
  }

  /** How far the conversation is counted, or undefined when it never was. */
  async cursorOf(conversationId: number): Promise<{ key: string; lastEntryId: number } | undefined> {
    const row = await this.#db.selectFrom("insights_cursor").select(["key", "last_entry_id"]).where("conversation_id", "=", conversationId).executeTakeFirst();
    return row ? { key: row.key, lastEntryId: row.last_entry_id } : undefined;
  }

  /** The row of `key` in the listing. */
  async listingOf(key: string): Promise<ListingRow | undefined> {
    const row = await this.#db.selectFrom("insights_conversation").selectAll().where("key", "=", key).executeTakeFirst();
    return row ? rowOf(row) : undefined;
  }

  /** Writes spend, cursor and listing row in one transaction, so a conversation is never counted twice or half. */
  async apply(commit: LedgerCommit): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      for (const delta of commit.spend) {
        const { input, output, cacheRead, cacheWrite, totalTokens } = delta.usage;
        await trx
          .insertInto("insights_spend")
          .values({
            key: commit.key,
            bucket: delta.bucket,
            kind: delta.kind,
            name: delta.name,
            input,
            output,
            cache_read: cacheRead,
            cache_write: cacheWrite,
            total_tokens: totalTokens,
          })
          .onConflict((conflict) =>
            conflict.columns(["key", "bucket", "kind", "name"]).doUpdateSet((eb) => ({
              input: eb("insights_spend.input", "+", input),
              output: eb("insights_spend.output", "+", output),
              cache_read: eb("insights_spend.cache_read", "+", cacheRead),
              cache_write: eb("insights_spend.cache_write", "+", cacheWrite),
              total_tokens: eb("insights_spend.total_tokens", "+", totalTokens),
            })),
          )
          .execute();
      }
      await trx
        .insertInto("insights_cursor")
        .values({ conversation_id: commit.conversationId, key: commit.key, last_entry_id: commit.lastEntryId })
        .onConflict((conflict) => conflict.column("conversation_id").doUpdateSet({ last_entry_id: commit.lastEntryId }))
        .execute();
      if (!commit.listing) return;
      const existing = await trx
        .selectFrom("insights_conversation")
        .select(["conversation_id", "last_active_at"])
        .where("key", "=", commit.key)
        .executeTakeFirst();
      // Another conversation's time says nothing of this one's.
      const before = existing?.conversation_id === commit.conversationId ? (existing.last_active_at ?? undefined) : undefined;
      const latest = [before, commit.listing.lastActiveAt].filter((at): at is number => at !== undefined);
      const lastActiveAt = latest.length > 0 ? Math.max(...latest) : null;
      await trx
        .insertInto("insights_conversation")
        .values({ key: commit.key, conversation_id: commit.conversationId, last_active_at: lastActiveAt })
        .onConflict((conflict) => conflict.column("key").doUpdateSet({ conversation_id: commit.conversationId, last_active_at: lastActiveAt }))
        .execute();
    });
  }

  /** Spend in the buckets `from` to `to` (inclusive, either may be open), summed per bucket and source; of one key, or of all. */
  async spend(range: { from?: number; to?: number }, key?: string): Promise<BucketSpend[]> {
    let query = this.#db
      .selectFrom("insights_spend")
      .select(["bucket", "kind", "name"])
      .select([
        sql<number>`sum(input)`.as("input"),
        sql<number>`sum(output)`.as("output"),
        sql<number>`sum(cache_read)`.as("cache_read"),
        sql<number>`sum(cache_write)`.as("cache_write"),
        sql<number>`sum(total_tokens)`.as("total_tokens"),
      ])
      .groupBy(["bucket", "kind", "name"])
      .orderBy("bucket");
    if (key !== undefined) query = query.where("key", "=", key);
    if (range.from !== undefined) query = query.where("bucket", ">=", range.from);
    if (range.to !== undefined) query = query.where("bucket", "<=", range.to);
    const rows = await query.execute();
    return rows.map((row) => ({
      bucket: row.bucket,
      kind: row.kind,
      name: row.name,
      usage: { input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write, totalTokens: row.total_tokens },
    }));
  }

  /** Every conversation that was ever created for `key`. */
  async conversationsOf(key: string): Promise<number[]> {
    const rows = await this.#db.selectFrom("insights_cursor").select("conversation_id").where("key", "=", key).execute();
    return rows.map((row) => row.conversation_id);
  }

  /** Up to `limit` rows, most recently active first; rows without a message come last, by key. */
  async page(limit: number, after?: ListingPosition): Promise<ListingRow[]> {
    let query = this.#db.selectFrom("insights_conversation").selectAll().orderBy("last_active_at", "desc").orderBy("key", "asc").limit(limit);
    if (after?.lastActiveAt === undefined && after) {
      query = query.where((eb) => eb.and([eb("last_active_at", "is", null), eb("key", ">", after.key)]));
    } else if (after?.lastActiveAt !== undefined) {
      const at = after.lastActiveAt;
      query = query.where((eb) =>
        eb.or([eb("last_active_at", "<", at), eb("last_active_at", "is", null), eb.and([eb("last_active_at", "=", at), eb("key", ">", after.key)])]),
      );
    }
    return (await query.execute()).map(rowOf);
  }
}

function rowOf(row: { key: string; conversation_id: number; last_active_at: number | null }): ListingRow {
  return { key: row.key, conversationId: row.conversation_id, lastActiveAt: row.last_active_at ?? undefined };
}
