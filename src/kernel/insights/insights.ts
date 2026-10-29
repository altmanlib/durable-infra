import type { ConversationId, UsageState } from "@earendil-works/pi-durable";

import { log } from "../../platform/log.ts";
import type { ConversationInfo, ConversationKey } from "../service/agent-service.ts";
import type { SessionReader } from "../service/reader.ts";
import type { UsageLedger } from "./ledger.ts";
import { BUCKET_MS, type ListingPosition, type ListingRow } from "./records/index.ts";
import { buildUsageReport, dayOf, type DayRange, isDay, type SpendRecord, type UsageCounters, type UsageReport, zeroCounters } from "./usage.ts";

/** Cumulative spend of one conversation key. */
export type KeySpend = {
  total: UsageCounters;
  /** By `provider/model`, compaction summaries included. */
  models: Readonly<Record<string, UsageCounters>>;
  /** By tool, for tools that call a model themselves. */
  tools: Readonly<Record<string, UsageCounters>>;
};

const COUNTER_NAMES = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

function countersOf(usage: Partial<UsageCounters>): UsageCounters {
  const counters = zeroCounters();
  for (const name of COUNTER_NAMES) counters[name] = usage[name] ?? 0;
  return counters;
}

/** A query its caller got wrong, such as a malformed date; the message says what to fix. */
export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

/** Rows a page of conversations has when the caller does not say. */
export const CONVERSATIONS_PAGE = 50;
/** The most rows a page may have. */
export const CONVERSATIONS_PAGE_MAX = 200;

/** A page of conversations, most recently active first. */
export type ConversationPage = {
  items: ConversationInfo[];
  /** Pass as `after` for the next page; absent on the last. */
  next?: string;
};

/** Longest offset of a time zone from UTC, plus a bucket, in ms: how far a day's buckets may lie outside it in UTC. */
const ZONE_MARGIN_MS = 15 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type InsightsOptions = {
  /** Time zone days are counted in; defaults to the process one (TZ). */
  timeZone?: string;
  /** Clock that decides what "today" is; defaults to the system clock. */
  now?: () => Date;
};

/** Read-only queries over the stored data. Returns plain objects; presenting them is the caller's job. */
export class Insights {
  readonly #reader: SessionReader;
  readonly #ledger: UsageLedger;
  readonly #timeZone: string;
  readonly #now: () => Date;

  constructor(reader: SessionReader, ledger: UsageLedger, options: InsightsOptions = {}) {
    this.#reader = reader;
    this.#ledger = ledger;
    this.#timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.#now = options.now ?? (() => new Date());
  }

  /** Cumulative spend of the conversation `key` currently points at, read in constant time; `undefined` when the key has none. Spend of an earlier conversation under the same key is not included. */
  async spentOf(key: ConversationKey): Promise<KeySpend | undefined> {
    if (key === "") return undefined;
    const id = await this.#reader.conversationOf(key);
    if (id === undefined) return undefined;
    const spent = await this.#reader.spent(id as ConversationId);
    const models = Object.fromEntries(Object.entries(spent?.models ?? {}).map(([name, usage]) => [name, countersOf(usage)]));
    const tools = Object.fromEntries(Object.entries(spent?.tools ?? {}).map(([name, usage]) => [name, countersOf(usage)]));
    const total = zeroCounters();
    for (const counters of [...Object.values(models), ...Object.values(tools)]) {
      for (const name of COUNTER_NAMES) total[name] += counters[name];
    }
    return { total, models, tools };
  }

  /** Token spend by day and by model or tool within `range` (`today` allowed). With `options.key`, only that channel key's conversations count. Reads the ledger, so the cost follows the buckets in range, not the history. */
  async usage(query: DayRange = {}, options: { key?: string } = {}): Promise<UsageReport> {
    const range: DayRange = {};
    for (const name of ["from", "to"] as const) {
      const value = query[name] === "today" ? dayOf(this.#now().getTime(), this.#timeZone) : query[name];
      if (value === undefined) continue;
      if (!isDay(value)) throw new QueryError(`${name} must be a date written as YYYY-MM-DD or "today", got "${value}"`);
      range[name] = value;
    }
    if (range.from && range.to && range.from > range.to) throw new QueryError(`from (${range.from}) is after to (${range.to})`);
    await this.#ledger.flush();
    // An empty key names no conversation.
    const rows = options.key === "" ? [] : await this.#ledger.store.spend(bucketsOf(range), options.key);
    const records: SpendRecord[] = rows.map((row) => ({ at: row.bucket * BUCKET_MS, kind: row.kind, name: row.name, usage: row.usage }));
    // Read last: spend committed meanwhile lands in undated, never below zero.
    const totals = options.key === undefined ? await this.#reader.usage() : await this.#spentByKey(options.key);
    const { report, mismatch } = buildUsageReport(records, totals, range, this.#timeZone);
    if (mismatch) log.warn("usage.mismatch", {});
    return report;
  }

  /** What Durable counted for every conversation ever made for `key`, entries or not. */
  async #spentByKey(key: string): Promise<UsageState> {
    const own: UsageState = { models: {}, tools: {} };
    if (key === "") return own;
    for (const id of await this.#ledger.store.conversationsOf(key)) {
      const spent = await this.#reader.spent(id as ConversationId);
      for (const bucket of ["models", "tools"] as const) {
        for (const [name, usage] of Object.entries(spent?.[bucket] ?? {})) own[bucket][`${id}:${name}`] = usage;
      }
    }
    return own;
  }

  /** Conversations with a channel key, most recently active first, `limit` at a time; forks, stale mappings and a key's conversation before its first message are left out. */
  async conversations(page: { limit?: number; after?: string } = {}): Promise<ConversationPage> {
    const limit = page.limit ?? CONVERSATIONS_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > CONVERSATIONS_PAGE_MAX) {
      throw new QueryError(`limit must be a whole number from 1 to ${CONVERSATIONS_PAGE_MAX}, got ${limit}`);
    }
    const after = page.after === undefined ? undefined : positionOf(page.after);
    await this.#ledger.flush();
    const rows = await this.#ledger.store.page(limit + 1, after);
    const shown = rows.slice(0, limit);
    const pending = await this.#reader.pendingInputs();
    const items = await Promise.all(shown.map((row) => this.#infoOf(row, pending)));
    const last = shown.at(-1);
    return { items, ...(rows.length > limit && last ? { next: cursorOf(last) } : {}) };
  }

  /** The listing entry of one key; `undefined` when it has none. */
  async conversation(key: ConversationKey): Promise<ConversationInfo | undefined> {
    await this.#ledger.flush();
    const row = key === "" ? undefined : await this.#ledger.store.listingOf(key);
    return row ? this.#infoOf(row, await this.#reader.pendingInputs()) : undefined;
  }

  async #infoOf(row: ListingRow, pending: readonly { key: string }[]): Promise<ConversationInfo> {
    const id = row.conversationId as ConversationId;
    const spent = await this.#reader.spent(id);
    const totalTokens = [...Object.values(spent?.models ?? {}), ...Object.values(spent?.tools ?? {})].reduce((sum, each) => sum + (each.totalTokens ?? 0), 0);
    return {
      key: row.key,
      busy: await this.#reader.isBusy(id),
      ...(row.lastActiveAt !== undefined ? { lastActiveAt: row.lastActiveAt } : {}),
      totalTokens,
      pending: pending.filter((item) => item.key === row.key).length,
    };
  }
}

/** The buckets a day range can touch, a day wider on each side than the zone needs; the report then cuts at the exact day. */
function bucketsOf(range: DayRange): { from?: number; to?: number } {
  return {
    ...(range.from ? { from: Math.floor((Date.parse(`${range.from}T00:00:00Z`) - ZONE_MARGIN_MS) / BUCKET_MS) } : {}),
    ...(range.to ? { to: Math.floor((Date.parse(`${range.to}T00:00:00Z`) + DAY_MS + ZONE_MARGIN_MS) / BUCKET_MS) } : {}),
  };
}

function cursorOf(row: ListingRow): string {
  return Buffer.from(JSON.stringify([row.lastActiveAt ?? null, row.key])).toString("base64url");
}

function positionOf(cursor: string): ListingPosition {
  try {
    const [at, key] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [unknown, unknown];
    if ((at === null || typeof at === "number") && typeof key === "string") return { lastActiveAt: at ?? undefined, key };
  } catch {
    // Falls through to the error below.
  }
  throw new QueryError("after is not a cursor this listing gave");
}
