import { type Kysely, sql } from "kysely";
import type { MemoSchema } from "./schema.ts";

/** The longest name of an entry, after normalizing, in UTF-16 code units. */
export const MAX_MEMO_NAME_CHARS = 64;
/** The most entries one conversation may have. */
export const MAX_MEMO_ENTRIES = 50;
/** The longest body of an entry, in UTF-16 code units. */
export const MAX_MEMO_BODY_CHARS = 8000;
/** The longest preview `list` gives of a body. */
export const MEMO_PREVIEW_CHARS = 80;

/** How much of a body the listing reads to find its first line: enough for a preview after some blank lines. */
const PREVIEW_READ_CHARS = 400;

/** An entry as `list` shows it: no body, only the start of its first line that is not blank. */
export type MemoSummary = { name: string; updatedAt: number; updatedBy: string; preview: string };
/** An entry in full. */
export type MemoEntry = { name: string; body: string; updatedAt: number; updatedBy: string };
/** What `set` came to; anything but `saved` changed nothing. */
export type MemoSetResult = "saved" | "invalid_name" | "too_large" | "too_many";
/** What `remove` came to; either way the entry is gone. */
export type MemoRemoveResult = "deleted" | "missing";

export type MemoEntriesOptions = { now?: () => number };

/**
 * A name as it is kept: without the spaces around it, and every run of whitespace inside one space. `undefined` when
 * nothing is left or it is longer than `MAX_MEMO_NAME_CHARS`.
 */
export function normalizeMemoName(name: string): string | undefined {
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized.length === 0 || normalized.length > MAX_MEMO_NAME_CHARS ? undefined : normalized;
}

/** The first line of `head` that is not blank, cut to `MEMO_PREVIEW_CHARS` with an ellipsis when it was longer. */
export function previewOf(head: string): string {
  const line =
    head
      .split("\n")
      .find((each) => each.trim() !== "")
      ?.trim() ?? "";
  return line.length > MEMO_PREVIEW_CHARS ? `${line.slice(0, MEMO_PREVIEW_CHARS)}…` : line;
}

/**
 * The memo of each conversation, entry by entry (docs/design/2026-10-19-group-memo.md §3.2); a conversation reaches only
 * its own entries, by its key. The limits are checked before writing. A write that fails is not swallowed: it throws,
 * and the caller says it was not kept (docs/persistence.md §6).
 */
export class MemoEntries {
  readonly #db: Kysely<MemoSchema>;
  readonly #now: () => number;

  constructor(db: Kysely<MemoSchema>, options: MemoEntriesOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  /** The conversation's entries, the one written last first. */
  async list(conversationKey: string): Promise<MemoSummary[]> {
    const rows = await this.#db
      .selectFrom("memo_entry")
      .select(["name", "updated_at", "updated_by"])
      .select(sql<string>`substr(body, 1, ${PREVIEW_READ_CHARS})`.as("head"))
      .where("conversation_key", "=", conversationKey)
      .orderBy("updated_at", "desc")
      .orderBy("name")
      .execute();
    return rows.map((row) => ({ name: row.name, updatedAt: row.updated_at, updatedBy: row.updated_by, preview: previewOf(row.head) }));
  }

  /** The entry of that name, or `undefined` when there is none (a name that cannot be kept included). */
  async get(conversationKey: string, name: string): Promise<MemoEntry | undefined> {
    const normalized = normalizeMemoName(name);
    if (normalized === undefined) return undefined;
    const row = await this.#db
      .selectFrom("memo_entry")
      .select(["name", "body", "updated_at", "updated_by"])
      .where("conversation_key", "=", conversationKey)
      .where("name", "=", normalized)
      .executeTakeFirst();
    return row && { name: row.name, body: row.body, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /**
   * Write the entry, replacing one of the same name. A new name is refused once the conversation has
   * `MAX_MEMO_ENTRIES`; replacing one is not. Throws when the write fails.
   */
  async set(conversationKey: string, name: string, body: string, updatedBy: string): Promise<MemoSetResult> {
    const normalized = normalizeMemoName(name);
    if (normalized === undefined) return "invalid_name";
    if (body.length > MAX_MEMO_BODY_CHARS) return "too_large";
    // Counting and writing in one transaction, so two new names written at once cannot both slip under the limit.
    return this.#db.transaction().execute(async (trx) => {
      const others = await trx
        .selectFrom("memo_entry")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("conversation_key", "=", conversationKey)
        .where("name", "<>", normalized)
        .executeTakeFirstOrThrow();
      const exists = await trx
        .selectFrom("memo_entry")
        .select("name")
        .where("conversation_key", "=", conversationKey)
        .where("name", "=", normalized)
        .executeTakeFirst();
      if (!exists && Number(others.count) >= MAX_MEMO_ENTRIES) return "too_many";
      const row = { body, updated_at: this.#now(), updated_by: updatedBy };
      await trx
        .insertInto("memo_entry")
        .values({ conversation_key: conversationKey, name: normalized, ...row })
        .onConflict((conflict) => conflict.columns(["conversation_key", "name"]).doUpdateSet(row))
        .execute();
      return "saved";
    });
  }

  /** Delete the entry of that name; `missing` when there was none, which is no failure. Throws when the write fails. */
  async remove(conversationKey: string, name: string): Promise<MemoRemoveResult> {
    const normalized = normalizeMemoName(name);
    if (normalized === undefined) return "missing";
    const result = await this.#db.deleteFrom("memo_entry").where("conversation_key", "=", conversationKey).where("name", "=", normalized).executeTakeFirst();
    return Number(result.numDeletedRows) > 0 ? "deleted" : "missing";
  }
}
