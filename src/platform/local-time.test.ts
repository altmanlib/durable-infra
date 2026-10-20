import { expect, test } from "bun:test";
import { formatLocal, parseLocal } from "./local-time.ts";

const MANILA = "Asia/Manila";
const NEW_YORK = "America/New_York";

test("a local time round-trips through parse and format in a fixed zone", () => {
  const ms = parseLocal("2026-10-05T18:30:00", MANILA);
  expect(ms).toBe(Date.parse("2026-10-05T10:30:00Z"));
  const text = formatLocal(new Date(ms as number), MANILA);
  expect(text).toContain("2026-10-05");
  expect(text).toContain("18:30:00");
});

test("formatted time carries neither an offset nor a UTC marker", () => {
  const text = formatLocal(new Date("2026-10-05T10:30:00Z"), MANILA);
  expect(text).not.toMatch(/Z\b|UTC|GMT|[+]\d{2}:?\d{2}|Manila/);
});

test("a time with its own offset is taken at its word", () => {
  expect(parseLocal("2026-10-05T18:30:00+08:00", NEW_YORK)).toBe(Date.parse("2026-10-05T10:30:00Z"));
  expect(parseLocal("2026-10-05T10:30:00Z", MANILA)).toBe(Date.parse("2026-10-05T10:30:00Z"));
});

test("minutes alone, or a space for the T, are fine", () => {
  expect(parseLocal("2026-10-05T18:30", MANILA)).toBe(Date.parse("2026-10-05T10:30:00Z"));
  expect(parseLocal("2026-10-05 18:30:00", MANILA)).toBe(Date.parse("2026-10-05T10:30:00Z"));
});

test("anything that is not a date with a time of day is refused", () => {
  for (const value of ["2026-10-05", "18:30", "tomorrow", "", "2026-02-30T10:00:00", "2026-10-05T25:00:00"]) {
    expect([value, parseLocal(value, MANILA)]).toEqual([value, undefined]);
  }
});

test("in a zone with daylight saving, a skipped time moves on and a repeated time is the first one", () => {
  // 2026-03-08 02:30 does not exist in New York; 03:30 EDT is 07:30Z.
  expect(parseLocal("2026-03-08T02:30:00", NEW_YORK)).toBe(Date.parse("2026-03-08T07:30:00Z"));
  // 2026-11-01 01:30 happens twice; the first is EDT, 05:30Z.
  expect(parseLocal("2026-11-01T01:30:00", NEW_YORK)).toBe(Date.parse("2026-11-01T05:30:00Z"));
});
