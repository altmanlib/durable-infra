import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirPerTest } from "../testing/testing.ts";
import { log, setLogSink } from "./log.ts";
import { LogFile, logToFile } from "./log-file.ts";

const dir = tempDirPerTest("log-file-");
const read = (name = "app.log") => readFileSync(join(dir(), name), "utf8");
const silent = () => {};

// Guards against a restart truncating the file, or lines landing out of order.
test("events are appended in order, and a reopened file is continued, not overwritten", () => {
  const first = new LogFile({ dir: dir(), report: silent });
  first.write("one");
  first.write("two");
  first.close();
  const second = new LogFile({ dir: dir(), report: silent });
  second.write("three");
  second.close();
  expect(read()).toBe("one\ntwo\nthree\n");
});

// Guards against the log growing without bound, and against rotation losing, repeating or splitting events.
test("rotation keeps the file count and sizes bounded and the newest events whole and in order", () => {
  const maxBytes = 100;
  const count = 3;
  const file = new LogFile({ dir: dir(), maxBytes, count, report: silent });
  const events = Array.from({ length: 50 }, (_, index) => `event-${String(index).padStart(2, "0")} ${"x".repeat(index % 7)}`);
  // A short stack, so one event with continuation lines still fits a file of this size.
  const failure = new Error("boom");
  failure.stack = "Error: boom\n    at here";
  for (const [index, event] of events.entries()) file.write(event, index === 40 ? failure : undefined);
  file.close();

  const names = readdirSync(dir()).sort();
  expect(names).toEqual(["app.1.log", "app.2.log", "app.log"]);
  for (const name of names) expect(statSync(join(dir(), name)).size).toBeLessThanOrEqual(maxBytes);

  // Oldest to newest; each file starts with an event, never with the continuation of one.
  const kept = ["app.2.log", "app.1.log", "app.log"].map((name) => read(name));
  for (const text of kept) expect(text.startsWith(" ")).toBe(false);
  const firstLines = kept
    .join("")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith(" "));
  expect(firstLines).toEqual(events.slice(events.length - firstLines.length));
  expect(firstLines.length).toBeGreaterThan(3);
});

// Guards against restarts letting app.log grow past its limit: the size already on disk counts.
test("a reopened file that is nearly full is rotated by the next event", () => {
  writeFileSync(join(dir(), "app.log"), `${"x".repeat(90)}\n`);
  const file = new LogFile({ dir: dir(), maxBytes: 100, report: silent });
  file.write("next event");
  file.close();
  expect(read()).toBe("next event\n");
  expect(read("app.1.log")).toBe(`${"x".repeat(90)}\n`);
});

// Guards against an error's stack reaching the console but not the file.
test("an event with an error is followed by its stack and causes as indented lines", () => {
  const file = new LogFile({ dir: dir(), report: silent });
  file.write("2026-10-07T00:00:00.000Z error x.failed", new Error("outer", { cause: new Error("inner") }));
  file.write("next");
  file.close();
  const lines = read().split("\n");
  expect(lines[0]).toBe("2026-10-07T00:00:00.000Z error x.failed");
  expect(lines[1]).toBe("  Error: outer");
  expect(lines.some((line) => /^ {2}at /.test(line))).toBe(true);
  expect(lines).toContain("  Caused by: Error: inner");
  expect(lines.filter((line) => line !== "" && !line.startsWith(" "))).toEqual(["2026-10-07T00:00:00.000Z error x.failed", "next"]);
});

// Guards against a broken disk crashing the service or flooding stderr, and against the file never coming back.
test("a failing directory never throws, is reported once, and is retried after the pause", () => {
  const blocked = join(dir(), "blocked");
  writeFileSync(blocked, "a file where the directory should be");
  let now = 1_000;
  const reports: string[] = [];
  const file = new LogFile({ dir: blocked, retryMs: 60_000, now: () => now, report: (line) => reports.push(line) });
  expect(() => {
    file.write("lost-1");
    file.write("lost-2");
  }).not.toThrow();
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain(" error log_file.failed ");
  expect(reports[0]).toContain("retryInSec=60");

  // Still broken at the retry: no second report.
  now += 60_000;
  file.write("lost-3");
  expect(reports).toHaveLength(1);

  rmSync(blocked);
  now += 60_000;
  file.write("back");
  file.close();
  expect(reports).toHaveLength(1);
  const lines = readFileSync(join(blocked, "app.log"), "utf8").trim().split("\n");
  expect(lines[0]).toMatch(/ warn log_file\.resumed dropped=3$/);
  expect(lines[1]).toBe("back");
});

// Guards against the file replacing the console (or an entry's filter) instead of adding to it, and against a sink left behind.
test("logToFile keeps the previous sink receiving every line, and its undo puts that sink back", () => {
  const seen: string[] = [];
  const mine = (line: string) => void seen.push(line);
  const before = setLogSink(mine);
  try {
    const undo = logToFile({ dir: dir(), report: silent });
    log.info("a.b", { n: 1 });
    log.error("c.d", {}, new Error("boom"));
    undo();
    log.info("after.undo");
    expect(seen).toHaveLength(3);
    expect(setLogSink(mine)).toBe(mine);
    const text = read();
    expect(text).toContain(" info a.b n=1\n");
    expect(text).toContain(" error c.d error=boom\n  Error: boom\n");
    expect(text).not.toContain("after.undo");
  } finally {
    setLogSink(before);
  }
  expect(existsSync(join(dir(), "app.1.log"))).toBe(false);
});
