import { expect, test } from "bun:test";

import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";

import { buildUsageReport, dayOf, isDay, spendOf, type SpendRecord, type UsageCounters } from "./usage.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const entry = (model: unknown[]): EntryRecord => ({ id: 1, conversationId: 1, kind: "x", model: model as Message[] }) as unknown as EntryRecord;

const counters = (input: number, output: number, cacheRead = 0, cacheWrite = 0): UsageCounters => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
});

const record = (iso: string, name: string, use: UsageCounters, kind: "model" | "tool" = "model"): SpendRecord => ({
  at: Date.parse(iso),
  kind,
  name,
  usage: use,
});

const ledger = (models: Record<string, UsageCounters>, tools: Record<string, UsageCounters> = {}): UsageState => ({ models, tools }) as unknown as UsageState;

test("spendOf reads model responses, failed ones too, and tool results that report spend", () => {
  const at = Date.parse("2026-10-06T08:00:00Z");
  expect(spendOf(entry([{ role: "assistant", provider: "p", model: "m", usage: usage(10, 2), stopReason: "error", timestamp: at }]))).toEqual([
    { at, kind: "model", name: "p/m", usage: counters(10, 2) },
  ]);
  expect(spendOf(entry([{ role: "toolResult", toolName: "web_fetch", usage: usage(5, 1, 3), timestamp: at }]))).toEqual([
    { at, kind: "tool", name: "web_fetch", usage: counters(5, 1, 3) },
  ]);
  expect(spendOf(entry([{ role: "toolResult", toolName: "current_time", timestamp: at }]))).toEqual([]);
  expect(spendOf(entry([{ role: "user", content: "hi", timestamp: at }]))).toEqual([]);
  expect(spendOf({ id: 1, conversationId: 1, kind: "pi.compaction" } as unknown as EntryRecord)).toEqual([]);
});

test("dayOf counts days in the given time zone", () => {
  const at = Date.parse("2026-10-05T17:30:00Z");
  expect(dayOf(at, "UTC")).toBe("2026-10-05");
  expect(dayOf(at, "Asia/Manila")).toBe("2026-10-06");
});

test("isDay accepts only real dates written as YYYY-MM-DD", () => {
  expect(isDay("2026-10-06")).toBe(true);
  expect(isDay("2024-02-29")).toBe(true);
  expect(isDay("2026-02-30")).toBe(false);
  expect(isDay("2026-1-6")).toBe(false);
  expect(isDay("today")).toBe(false);
});

const records = [
  record("2026-10-04T10:00:00Z", "p/m", counters(10, 1)),
  record("2026-10-05T10:00:00Z", "p/m", counters(20, 2)),
  record("2026-10-05T11:00:00Z", "p/m", counters(30, 3)),
  record("2026-10-05T12:00:00Z", "web_fetch", counters(5, 5), "tool"),
];

test("an open range groups by day and source, and reports Durable's extra spend as undated", () => {
  const { report, mismatch } = buildUsageReport(records, ledger({ "p/m": counters(100, 6) }, { web_fetch: counters(5, 5) }), {}, "UTC");
  expect(mismatch).toBe(false);
  expect(report.days.map((day) => day.date)).toEqual(["2026-10-04", "2026-10-05"]);
  expect(report.days[1]?.sources).toEqual([
    { kind: "model", name: "p/m", ...counters(50, 5) },
    { kind: "tool", name: "web_fetch", ...counters(5, 5) },
  ]);
  expect(report.days[1]?.total).toEqual(counters(55, 10));
  expect(report.undated).toEqual(counters(40, 0));
  expect(report.total).toEqual(counters(105, 11));
});

test("a range keeps only its days and gives no undated part", () => {
  const { report } = buildUsageReport(records, ledger({ "p/m": counters(100, 6) }), { from: "2026-10-05", to: "2026-10-05" }, "UTC");
  expect(report.days.map((day) => day.date)).toEqual(["2026-10-05"]);
  expect(report.undated).toBeUndefined();
  expect(report.total).toEqual(counters(55, 10));
  expect(report).toMatchObject({ from: "2026-10-05", to: "2026-10-05" });
});

test("records beyond Durable's ledger are flagged and never make undated negative", () => {
  const { report, mismatch } = buildUsageReport(records, ledger({ "p/m": counters(1, 1) }), {}, "UTC");
  expect(mismatch).toBe(true);
  expect(report.undated).toEqual(counters(0, 0));
});

test("no records and no ledger is an empty report", () => {
  const { report } = buildUsageReport([], ledger({}), {}, "UTC");
  expect(report.days).toEqual([]);
  expect(report.total).toEqual(counters(0, 0));
});
