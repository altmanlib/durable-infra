import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";

/** Token counters of a usage report. Cost is left out: the configured model prices are all zero. */
export type UsageCounters = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

/** Spend of one model (`provider/model`) or one tool (its own model calls) on one day. */
export type UsageSource = { kind: "model" | "tool"; name: string } & UsageCounters;

export type UsageDay = { date: string; total: UsageCounters; sources: UsageSource[] };

/** Inclusive day range, `YYYY-MM-DD` in the report's time zone; an absent end is open. A query may also say `today`. */
export type DayRange = { from?: string; to?: string };

export type UsageReport = {
  /** Time zone the days are counted in. */
  timeZone: string;
  from?: string;
  to?: string;
  /** Days with spend, oldest first. */
  days: UsageDay[];
  /** Spend Durable counted with no date (such as compaction summaries); given only for an open range. */
  undated?: UsageCounters;
  /** Sum of `days`, plus `undated` when given. */
  total: UsageCounters;
};

/** One dated piece of spend read from a transcript entry. */
export type SpendRecord = { at: number; kind: "model" | "tool"; name: string; usage: UsageCounters };

const COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

export const zeroCounters = (): UsageCounters => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

function add(total: UsageCounters, usage: Partial<UsageCounters>): void {
  for (const name of COUNTERS) total[name] += usage[name] ?? 0;
}

/** Dated spend of an entry: each model response, and each tool result that reports its own spend. */
export function spendOf(entry: EntryRecord): SpendRecord[] {
  const records: SpendRecord[] = [];
  for (const message of entry.model ?? ([] as readonly Message[])) {
    if (message.role === "assistant") {
      records.push({ at: message.timestamp, kind: "model", name: `${message.provider}/${message.model}`, usage: counters(message.usage) });
    } else if (message.role === "toolResult" && message.usage) {
      records.push({ at: message.timestamp, kind: "tool", name: message.toolName, usage: counters(message.usage) });
    }
  }
  return records;
}

function counters(usage: Partial<UsageCounters>): UsageCounters {
  const result = zeroCounters();
  add(result, usage);
  return result;
}

/** `YYYY-MM-DD` of `at` in `timeZone`. */
export function dayOf(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Whether `value` is a real calendar day written as `YYYY-MM-DD`. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Groups `records` by day and source; what Durable's `totals` hold beyond them is `undated`. A negative difference sets `mismatch`. */
export function buildUsageReport(
  records: Iterable<SpendRecord>,
  totals: UsageState,
  range: DayRange,
  timeZone: string,
): { report: UsageReport; mismatch: boolean } {
  const days = new Map<string, Map<string, UsageSource>>();
  const dated = zeroCounters();
  for (const record of records) {
    add(dated, record.usage);
    const date = dayOf(record.at, timeZone);
    if ((range.from && date < range.from) || (range.to && date > range.to)) continue;
    const sources = days.get(date) ?? new Map<string, UsageSource>();
    days.set(date, sources);
    const id = `${record.kind}:${record.name}`;
    const source = sources.get(id) ?? { kind: record.kind, name: record.name, ...zeroCounters() };
    sources.set(id, source);
    add(source, record.usage);
  }

  const total = zeroCounters();
  const report: UsageReport = { timeZone, ...range, days: [], total };
  for (const date of [...days.keys()].sort()) {
    const sources = [...(days.get(date)?.values() ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    const dayTotal = zeroCounters();
    for (const source of sources) add(dayTotal, source);
    add(total, dayTotal);
    report.days.push({ date, total: dayTotal, sources });
  }

  let mismatch = false;
  if (!range.from && !range.to) {
    const counted = zeroCounters();
    for (const usage of [...Object.values(totals.models), ...Object.values(totals.tools)]) add(counted, usage);
    const undated = zeroCounters();
    for (const name of COUNTERS) {
      const rest = counted[name] - dated[name];
      if (rest < 0) mismatch = true;
      undated[name] = Math.max(0, rest);
    }
    report.undated = undated;
    add(total, undated);
  }
  return { report, mismatch };
}
