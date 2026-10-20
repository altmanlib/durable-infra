import { log } from "../../platform/log.ts";
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
   */
  async usage(query: DayRange = {}): Promise<UsageReport> {
    const range: DayRange = {};
    for (const name of ["from", "to"] as const) {
      const value = query[name] === "today" ? dayOf(this.#now().getTime(), this.#timeZone) : query[name];
      if (value === undefined) continue;
      if (!isDay(value)) throw new QueryError(`${name} must be a date written as YYYY-MM-DD or "today", got "${value}"`);
      range[name] = value;
    }
    if (range.from && range.to && range.from > range.to) throw new QueryError(`from (${range.from}) is after to (${range.to})`);
    const records: SpendRecord[] = [];
    for await (const id of this.#reader.conversations()) {
      for await (const entry of this.#reader.entries(id)) records.push(...spendOf(entry));
    }
    // Read the ledger last: spend committed during the scan then lands in undated for this one report, never below zero.
    const totals = await this.#reader.usage();
    const { report, mismatch } = buildUsageReport(records, totals, range, this.#timeZone);
    if (mismatch) log.warn("usage.mismatch", {});
    return report;
  }
}
