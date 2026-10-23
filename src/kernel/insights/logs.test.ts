import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LogFile } from "../../platform/log-file.ts";
import { formatLine } from "../../platform/log.ts";
import { tempDirPerTest } from "../../testing/testing.ts";
import { QueryError } from "./insights.ts";
import { type LogPage, type LogQuery, LogReader, parseEntry } from "./logs.ts";

const dir = tempDirPerTest("log-reader-");
const T0 = Date.parse("2026-10-07T00:00:00.000Z");
const at = (index: number) => new Date(T0 + index * 1000);
const silent = () => {};

/** Write `count` events through the real writer; every seventh is a warning with a stack, every thirteenth an error. */
function writeEvents(count: number, options: { maxBytes?: number; logCount?: number; from?: number } = {}): string[] {
  const file = new LogFile({ dir: dir(), maxBytes: options.maxBytes ?? 1_000_000, count: options.logCount ?? 5, report: silent });
  const heads: string[] = [];
  for (let n = options.from ?? 0; n < (options.from ?? 0) + count; n++) {
    const level = n % 13 === 0 ? "error" : n % 7 === 0 ? "warn" : "info";
    const event = n % 2 === 0 ? "feishu.message.received" : "turn.done";
    const error = level === "info" ? undefined : Object.assign(new Error(`failure ${n}`), { stack: `Error: failure ${n}\n    at step${n} (x.ts:1:1)` });
    const head = formatLine(level, event, { n, note: n % 5 === 0 ? `two words ${n}` : undefined }, error, at(n));
    file.write(head, error);
    heads.push(head);
  }
  file.close();
  return heads;
}

/** Every page of a query, following `next`. */
async function allPages(reader: LogReader, query: LogQuery = {}): Promise<LogPage[]> {
  const pages: LogPage[] = [];
  let cursor: string | undefined;
  do {
    const page = await reader.read({ ...query, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    cursor = page.next ?? undefined;
  } while (cursor);
  return pages;
}

// Guards against the console showing a stack as events of its own, or values with spaces cut apart.
test("an entry is its first line parsed, with its continuation lines; a line out of format is kept as it is", () => {
  const entry = parseEntry('2026-10-07T00:00:01.000Z warn web_fetch.failed host=example.com note="two words" error="a \\"b\\""', ["Error: x", "at y"]);
  expect(entry).toEqual({
    at: T0 + 1000,
    level: "warn",
    event: "web_fetch.failed",
    fields: [
      ["host", "example.com"],
      ["note", "two words"],
      ["error", 'a "b"'],
    ],
    detail: ["Error: x", "at y"],
    line: '2026-10-07T00:00:01.000Z warn web_fetch.failed host=example.com note="two words" error="a \\"b\\""',
  });
  expect(parseEntry("not a log line")).toMatchObject({ at: null, level: null, event: "", line: "not a log line" });
});

// Guards against paging that loses, repeats or reorders events at chunk, page and file edges, and stacks split from their events.
test("pages read newest first across rotated files and small chunks, every event once, each with its own stack", async () => {
  const heads = writeEvents(400, { maxBytes: 4_000, logCount: 50 });
  const reader = new LogReader({ dir: dir(), count: 50, chunkBytes: 64 });
  const pages = await allPages(reader, { limit: 37 });
  const entries = pages.flatMap((page) => page.entries);
  expect(entries.map((entry) => entry.line)).toEqual([...heads].reverse());
  for (const entry of entries) {
    const n = Number(entry.fields.find(([name]) => name === "n")?.[1]);
    expect(entry.detail).toEqual(entry.level === "info" ? [] : [`Error: failure ${n}`, `at step${n} (x.ts:1:1)`]);
  }
  expect(pages.at(-1)?.next).toBeNull();
});

// Guards against a rotation between two pages making the next page skip or repeat events.
test("a cursor still points to the same place after the files rotate under it", async () => {
  const heads = writeEvents(100, { maxBytes: 3_000, logCount: 50 });
  const reader = new LogReader({ dir: dir(), count: 50 });
  const first = await reader.read({ limit: 30 });
  // Enough new events to push app.log, and the file the cursor points into, along by a few names.
  writeEvents(60, { maxBytes: 3_000, logCount: 50, from: 100 });
  const rest = (await allPages(reader, { limit: 30, cursor: first.next ?? "" })).flatMap((page) => page.entries);
  expect([...first.entries, ...rest].map((entry) => entry.line)).toEqual([...heads].reverse());
});

// Guards against an old cursor reading some other file, and a made-up one reaching the file system.
test("a cursor into a file rotated away answers an empty last page; one this service never gave is a QueryError", async () => {
  writeEvents(100, { maxBytes: 3_000, logCount: 3 });
  const reader = new LogReader({ dir: dir(), count: 3 });
  const first = await reader.read({ limit: 5 });
  writeEvents(200, { maxBytes: 3_000, logCount: 3, from: 100 });
  expect(await reader.read({ cursor: first.next ?? "" })).toEqual({ entries: [], next: null });
  for (const cursor of ["../../etc/passwd", "1:2:3", "abc:1", ""]) await expect(reader.read({ cursor })).rejects.toBeInstanceOf(QueryError);
  await expect(reader.read({ limit: 0 })).rejects.toBeInstanceOf(QueryError);
  await expect(reader.read({ limit: 501 })).rejects.toBeInstanceOf(QueryError);
  await expect(reader.read({ level: "debug" as never })).rejects.toBeInstanceOf(QueryError);
  await expect(reader.read({ text: "x".repeat(201) })).rejects.toBeInstanceOf(QueryError);
});

// Guards against filters that miss what they should find (a word only in a stack) or let through what they should not.
test("filters by least level, event prefix, text anywhere in the event, and time", async () => {
  writeEvents(100);
  const reader = new LogReader({ dir: dir() });
  const lines = async (query: LogQuery) => (await allPages(reader, query)).flatMap((page) => page.entries);
  const ns = async (query: LogQuery) => (await lines(query)).map((entry) => Number(entry.fields[0]?.[1]));
  const down = (list: number[]) => [...list].reverse();
  const range = (count: number) => Array.from({ length: count }, (_, n) => n);

  expect(await ns({ level: "error" })).toEqual(down(range(100).filter((n) => n % 13 === 0)));
  expect(await ns({ level: "warn" })).toEqual(down(range(100).filter((n) => n % 13 === 0 || n % 7 === 0)));
  expect(await ns({ event: "feishu." })).toEqual(down(range(100).filter((n) => n % 2 === 0)));
  expect(await ns({ text: "STEP42 (" })).toEqual([42]);
  expect(await ns({ text: "two words 35" })).toEqual([35]);
  expect(await ns({ from: at(90).getTime() })).toEqual(down(range(100).slice(90)));
  expect(await ns({ from: at(10).getTime(), to: at(12).getTime() })).toEqual([12, 11, 10]);
});

// Guards against one strict search reading every file in a single request.
test("a search stops after its scan limit with a cursor, and going on finds what is further back", async () => {
  writeEvents(300);
  const reader = new LogReader({ dir: dir(), scanBytes: 2_000, chunkBytes: 256 });
  // Event 14 is a warning near the start of the file: far behind the first 2,000 bytes.
  const first = await reader.read({ text: "step14 (" });
  expect(first.entries).toEqual([]);
  expect(first.next).not.toBeNull();
  const pages = await allPages(reader, { text: "step14 (" });
  expect(pages.length).toBeGreaterThan(2);
  expect(pages.flatMap((page) => page.entries).map((entry) => entry.fields[0]?.[1])).toEqual(["14"]);
});

// Guards against a fresh service (no log yet) or a missing directory breaking the page.
test("no directory, or no files in it, is an empty page", async () => {
  expect(await new LogReader({ dir: join(dir(), "missing") }).read()).toEqual({ entries: [], next: null });
  writeFileSync(join(dir(), "other.txt"), "x");
  expect(await new LogReader({ dir: dir() }).read()).toEqual({ entries: [], next: null });
  rmSync(join(dir(), "other.txt"));
});
