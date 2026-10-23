import { expect, test } from "bun:test";

import { SlidingWindow } from "./sliding-window.ts";

test("a key may start `max` inputs per window and is refused after that", () => {
  const window = new SlidingWindow({ max: 3, windowMs: 1000 });
  expect([0, 100, 200].map((at) => window.tryStart("a", at))).toEqual([true, true, true]);
  expect(window.tryStart("a", 300)).toBe(false);
});

test("the window slides: room comes back as old starts age out", () => {
  const window = new SlidingWindow({ max: 2, windowMs: 1000 });
  window.tryStart("a", 0);
  window.tryStart("a", 400);
  expect(window.tryStart("a", 900)).toBe(false);
  expect(window.tryStart("a", 1000)).toBe(true);
  expect(window.tryStart("a", 1100)).toBe(false);
  expect(window.tryStart("a", 1400)).toBe(true);
});

test("a refused start is not counted, and keys do not share a window", () => {
  const window = new SlidingWindow({ max: 1, windowMs: 1000 });
  expect(window.tryStart("a", 0)).toBe(true);
  expect(window.tryStart("a", 500)).toBe(false);
  expect(window.tryStart("a", 1000)).toBe(true);
  expect(window.tryStart("b", 1000)).toBe(true);
});

test("`record` counts an event whether or not there is room, and `full` says when the key has used up its events", () => {
  const window = new SlidingWindow({ max: 2, windowMs: 1000 });
  expect(window.full("a", 0)).toBe(false);
  expect(window.record("a", 0)).toBe(1);
  expect(window.record("a", 100)).toBe(2);
  expect(window.full("a", 200)).toBe(true);
  expect(window.record("a", 300)).toBe(3);
  expect(window.count("a", 1050)).toBe(2);
  expect(window.full("a", 1050)).toBe(true);
  expect(window.count("a", 1150)).toBe(1);
  expect(window.full("a", 1150)).toBe(false);
  expect(window.count("a", 1301)).toBe(0);
  expect(window.full("a", 1301)).toBe(false);
});

test("a flood of keys cannot grow the memory without bound: the keys whose events left the window are let go at the limit", () => {
  const window = new SlidingWindow({ max: 1, windowMs: 1000, maxKeys: 3 });
  for (const key of ["a", "b", "c"]) window.record(key, 0);
  expect(window.size).toBe(3);
  window.record("d", 2000);
  // Only the live key is held now; the old ones started over.
  expect(window.size).toBe(1);
  expect(window.count("d", 2000)).toBe(1);
});
