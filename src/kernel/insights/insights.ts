import type { UsageState } from "@earendil-works/pi-durable";
import { log } from "../../platform/log.ts";
import type { ConversationInfo } from "../service/agent-service.ts";
import type { SessionReader } from "../service/reader.ts";
import { buildUsageReport, type DayRange, dayOf, isDay, type SpendRecord, spendOf, type UsageReport } from "./usage.ts";

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

  /**
   * Token spend by day and by model or tool, within `range`. Either end may be `today`, resolved in the report time
   * zone, so a client in another time zone still asks for the service's day. Counted afresh from the transcripts.
   *
   * With `options.key` only the conversations of that channel key count, and so does their own ledger: what a person
   * has spent, whatever the others have. A key with no conversation gives an empty report, not an error; the empty key
   * names none, so it is the way to ask for nothing, never for everything.
   *
   * Without `options.key` the report is the whole service's.
   */
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
    // With a key, the ledger is that of its conversations alone; each source is named by its conversation so none is merged away.
    const own: UsageState = { models: {}, tools: {} };
    for await (const id of this.#reader.conversations()) {
      if (options.key !== undefined && (await this.#reader.keyOf(id)) !== options.key) continue;
      for await (const entry of this.#reader.entries(id)) records.push(...spendOf(entry));
      if (options.key === undefined) continue;
      // Read after the entries, as the whole ledger is below: spend committed during the scan lands in undated, never below zero.
      const spent = await this.#reader.spent(id);
      for (const bucket of ["models", "tools"] as const) {
        for (const [name, usage] of Object.entries(spent?.[bucket] ?? {})) own[bucket][`${id}:${name}`] = usage;
      }
    }
    // Read the ledger last: spend committed during the scan then lands in undated for this one report, never below zero.
    const totals = options.key === undefined ? await this.#reader.usage() : own;
    const { report, mismatch } = buildUsageReport(records, totals, range, this.#timeZone);
    if (mismatch) log.warn("usage.mismatch", {});
    return report;
  }

  /**
   * Every conversation that has a channel key, most recently active first. Forks and conversations whose key now points
   * at a newer one (a stale mapping) are left out: they cannot be addressed by key.
   */
  conversations(): Promise<ConversationInfo[]> {
    return this.#reader.listConversations();
  }
}
