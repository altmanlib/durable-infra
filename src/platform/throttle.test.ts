import { expect, test } from "bun:test";

import { Throttle } from "./throttle.ts";

test("the first time is allowed, then nothing until the interval is over, and each key has its own", () => {
  const throttle = new Throttle(1000);
  expect(throttle.allow(0, "a")).toBe(true);
  expect(throttle.allow(500, "a")).toBe(false);
  expect(throttle.allow(500, "b")).toBe(true);
  expect(throttle.allow(999, "a")).toBe(false);
  expect(throttle.allow(1000, "a")).toBe(true);
  // A refused attempt does not push the next one back.
  expect(throttle.allow(1500, "a")).toBe(false);
  expect(throttle.allow(2000, "a")).toBe(true);
});

test("without a key there is one; a number is a key too", () => {
  const throttle = new Throttle(1000);
  expect(throttle.allow(0)).toBe(true);
  expect(throttle.allow(1)).toBe(false);
  expect(throttle.allow(0, 7)).toBe(true);
  expect(throttle.allow(1, 7)).toBe(false);
});

test("a flood of keys is let go of once their interval is over, not kept for ever", () => {
  const throttle = new Throttle(1000, { maxKeys: 3 });
  for (const key of ["a", "b", "c"]) throttle.allow(0, key);
  expect(throttle.size).toBe(3);
  // At the limit the old ones are swept; only the new key is held.
  expect(throttle.allow(1000, "d")).toBe(true);
  expect(throttle.size).toBe(1);
  expect(throttle.allow(1000, "a")).toBe(true);
});
