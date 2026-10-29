import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { UsageState } from "@earendil-works/pi-durable";

import { type LedgeredService, openLedgered } from "../../testing/ledger.ts";
import { captureLogs, fauxSetup, tempDirPerTest } from "../../testing/testing.ts";
import { QueryError } from "../index.ts";
import type { SessionReader } from "../service/reader.ts";
import { BUCKET_MS } from "./records/index.ts";
import { buildUsageReport, dayOf, type DayRange, spendOf, type SpendRecord, type UsageReport } from "./usage.ts";

const { faux, models, model } = fauxSetup({ tokensPerSecond: 4000 });
const dir = tempDirPerTest("ledger-");

function respond(transcript: TranscriptContext) {
  const first = transcript.messages[0];
  if (first?.role === "system" && typeof first.content === "string" && first.content.includes("summarization"))
    return fauxAssistantMessage("## Summary\ntest summary");
  return fauxAssistantMessage(`answer ${"word ".repeat(40)}end`);
}

beforeEach(() => faux.setResponses(Array.from({ length: 200 }, () => respond)));

const opened: LedgeredService[] = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});

async function open(recordsPath = ":memory:", name = "agent"): Promise<LedgeredService> {
  const ledgered = await openLedgered(
    { databasePath: join(dir(), `${name}.sqlite`), models, model, settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 50 } } },
    recordsPath,
  );
  opened.push(ledgered);
  return ledgered;
}

async function close(ledgered: LedgeredService): Promise<void> {
  opened.splice(opened.indexOf(ledgered), 1);
  await ledgered.close();
}

const say = async (ledgered: LedgeredService, key: string, text: string, requestId: string) => {
  await (
    await ledgered.service.send(key, text, requestId)
  ).answer;
};

/** The report the way it was made before the ledger: every entry of every conversation read and added up. */
async function scanned(reader: SessionReader, range: DayRange, timeZone: string, key?: string): Promise<UsageReport> {
  const records: SpendRecord[] = [];
  const own: UsageState = { models: {}, tools: {} };
  for await (const id of reader.conversations()) {
    if (key !== undefined && (await reader.keyOf(id)) !== key) continue;
    for await (const entry of reader.entries(id)) records.push(...spendOf(entry));
    if (key === undefined) continue;
    const spent = await reader.spent(id);
    for (const bucket of ["models", "tools"] as const) {
      for (const [name, usage] of Object.entries(spent?.[bucket] ?? {})) own[bucket][`${id}:${name}`] = usage;
    }
  }
  return buildUsageReport(records, key === undefined ? await reader.usage() : own, range, timeZone).report;
}

/** Every way of asking that the ledger must answer as the scan does. */
async function expectSameAsScan(ledgered: LedgeredService): Promise<void> {
  const keys = [undefined, "a", "b", "nobody"];
  for (const timeZone of ["UTC", "Asia/Kolkata", "Asia/Kathmandu", "Pacific/Chatham"]) {
    const today = dayOf(Date.now(), timeZone);
    for (const range of [{}, { from: today, to: today }, { from: today }, { to: today }] as DayRange[]) {
      for (const key of keys) {
        const asked = await ledgered.insights({ timeZone }).usage(range, key === undefined ? {} : { key });
        expect(asked).toEqual(await scanned(ledgered.service.reader, range, timeZone, key));
      }
    }
  }
}

async function fill(ledgered: LedgeredService): Promise<void> {
  await say(ledgered, "a", "one", "r1");
  await say(ledgered, "b", "two", "r2");
  await say(ledgered, "a", "three", "r3");
  expect(await ledgered.service.compact("a")).toBe("compacted");
  await ledgered.service.reset("a");
  await say(ledgered, "a", "four", "r4");
}

test("the ledger answers every question as reading all entries does: by day, zone, range and key", async () => {
  const ledgered = await open();
  await fill(ledgered);
  await expectSameAsScan(ledgered);
});

test("a ledger that starts over an existing history counts all of it, exactly as the live one did", async () => {
  const first = await open(":memory:", "history");
  await fill(first);
  const live = await first.insights({ timeZone: "UTC" }).usage();
  await close(first);

  const refilled = await open(join(dir(), "fresh-records.sqlite"), "history");
  expect(await refilled.insights({ timeZone: "UTC" }).usage()).toEqual(live);
  await expectSameAsScan(refilled);
});

test("work the database refused is counted by the next try, and by the next start, never twice", async () => {
  const records = join(dir(), "records.sqlite");
  const first = await open(records);
  await say(first, "a", "one", "r1");
  const { store } = first.ledger;
  const apply = store.apply.bind(store);
  store.apply = async () => {
    throw new Error("disk full");
  };
  const logs = await captureLogs(async () => {
    await say(first, "b", "two", "r2");
    await expect(first.ledger.flush()).rejects.toThrow("disk full");
  });
  expect(logs.some((entry) => entry.line.includes("insights.ledger_failed"))).toBe(true);
  store.apply = apply;
  await first.ledger.flush();
  await first.ledger.flush();
  await expectSameAsScan(first);

  // A crash: the commit is in Durable, the ledger never saw it.
  store.apply = async () => {
    throw new Error("killed");
  };
  await say(first, "a", "three", "r3");
  await close(first);

  const second = await open(records);
  await expectSameAsScan(second);
  await second.ledger.flush();
  await expectSameAsScan(second);
});

test("queries and listings read the ledger: no conversation and no entry is scanned", async () => {
  const ledgered = await open();
  await fill(ledgered);
  await ledgered.ledger.flush();
  const refuse = () => {
    throw new Error("scanned");
  };
  Object.assign(ledgered.service.reader, { entries: refuse, conversations: refuse });
  const insights = ledgered.insights({ timeZone: "UTC" });
  expect((await insights.usage()).total.totalTokens).toBeGreaterThan(0);
  expect((await insights.usage({}, { key: "a" })).total.totalTokens).toBeGreaterThan(0);
  expect((await insights.conversations()).items).toHaveLength(2);
  expect((await insights.conversation("a"))?.key).toBe("a");
});

test("pages follow one another without repeating a key, even when a conversation moves up meanwhile", async () => {
  const ledgered = await open();
  const keys = ["k1", "k2", "k3", "k4", "k5"];
  for (const [index, key] of keys.entries()) {
    await say(ledgered, key, "hi", `r${index}`);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  const insights = ledgered.insights();
  const whole = (await insights.conversations()).items.map((info) => info.key);
  expect(whole.sort()).toEqual(keys);

  const seen: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const { items, next } = await insights.conversations({ limit: 2, ...(after ? { after } : {}) });
    expect(items.length).toBeLessThanOrEqual(2);
    seen.push(...items.map((info) => info.key));
    if (page === 0) await say(ledgered, "k1", "again", "late");
    if (!next) break;
    after = next;
  }
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.length).toBeLessThanOrEqual(5);
  // The first page is the two most recent, whatever happened after it.
  expect(seen.slice(0, 2).sort()).toEqual(["k4", "k5"]);
});

test("a page is asked for with a sensible size and a cursor the listing gave", async () => {
  const insights = (await open()).insights();
  for (const limit of [0, -1, 1.5, 201]) await expect(insights.conversations({ limit })).rejects.toBeInstanceOf(QueryError);
  await expect(insights.conversations({ after: "not a cursor" })).rejects.toBeInstanceOf(QueryError);
  expect(await insights.conversation("nobody")).toBeUndefined();
  expect(await insights.conversation("")).toBeUndefined();
});

test("a day boundary of any time zone in use falls between buckets, so a bucket belongs to one day", () => {
  const start = Date.parse("2026-03-28T00:00:00Z");
  const zones = [
    "UTC",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Pacific/Chatham",
    "America/St_Johns",
    "Australia/Lord_Howe",
    "Pacific/Kiritimati",
    "Pacific/Pago_Pago",
  ];
  for (const timeZone of zones) {
    for (let minute = 0; minute < 3 * 24 * 60; minute += 5) {
      const at = start + minute * 60_000;
      const bucketStart = Math.floor(at / BUCKET_MS) * BUCKET_MS;
      expect(dayOf(at, timeZone)).toBe(dayOf(bucketStart, timeZone));
    }
  }
});
