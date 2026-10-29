import type { ConversationId, UsageState } from "@earendil-works/pi-durable";

import { log } from "../../platform/log.ts";
import type { ConversationInfo, ConversationKey } from "../service/agent-service.ts";
import type { SessionReader } from "../service/reader.ts";
import { buildUsageReport, dayOf, type DayRange, isDay, spendOf, type SpendRecord, type UsageCounters, type UsageReport, zeroCounters } from "./usage.ts";

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

export type InsightsOptions = {
  /** Time zone days are counted in; defaults to the process one (TZ). */
  timeZone?: string;
  /** Clock that decides what "today" is; defaults to the system clock. */
  now?: () => Date;
};

/** Read-only queries over the stored data. Returns plain objects; presenting them is the caller's job. */
export class Insights {
  readonly #reader: SessionReader;
  readonly #timeZone: string;
  readonly #now: () => Date;

  constructor(reader: SessionReader, options: InsightsOptions = {}) {
    this.#reader = reader;
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

  /** Token spend by day and by model or tool within `range` (`today` allowed). With `options.key`, only that channel key's conversations count. Scans every conversation and its entries: for an operator's occasional query, not for a request path; use `spentOf` there. */
  async usage(query: DayRange = {}, options: { key?: string } = {}): Promise<UsageReport> {
    const range: DayRange = {};
    for (const name of ["from", "to"] as const) {
      const value = query[name] === "today" ? dayOf(this.#now().getTime(), this.#timeZone) : query[name];
      if (value === undefined) continue;
      if (!isDay(value)) throw new QueryError(`${name} must be a date written as YYYY-MM-DD or "today", got "${value}"`);
      range[name] = value;
    }
    if (range.from && range.to && range.from > range.to) throw new QueryError(`from (${range.from}) is after to (${range.to})`);
    const records: SpendRecord[] = [];
    // With a key, count only that key's conversations.
    const own: UsageState = { models: {}, tools: {} };
    for await (const id of this.#reader.conversations()) {
      if (options.key !== undefined && (await this.#reader.keyOf(id)) !== options.key) continue;
      for await (const entry of this.#reader.entries(id)) records.push(...spendOf(entry));
      if (options.key === undefined) continue;
      const spent = await this.#reader.spent(id);
      for (const bucket of ["models", "tools"] as const) {
        for (const [name, usage] of Object.entries(spent?.[bucket] ?? {})) own[bucket][`${id}:${name}`] = usage;
      }
    }
    // Read last: spend committed during the scan lands in undated, never below zero.
    const totals = options.key === undefined ? await this.#reader.usage() : own;
    const { report, mismatch } = buildUsageReport(records, totals, range, this.#timeZone);
    if (mismatch) log.warn("usage.mismatch", {});
    return report;
  }

  /** Conversations with a channel key, most recently active first; forks and stale mappings are omitted. */
  conversations(): Promise<ConversationInfo[]> {
    return this.#reader.listConversations();
  }
}
