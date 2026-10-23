import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { tempDirPerTest } from "./testing.ts";

const dir = tempDirPerTest("testing-");
const seen: string[] = [];

// Registered after the helper, like the `afterEach` that closes a service in the tests that use it.
afterEach(() => {
  // A service closes its database here, so the directory must still be there.
  expect(existsSync(dir())).toBe(true);
});

test("a test gets its own directory", () => {
  seen.push(dir());
  expect(existsSync(dir())).toBe(true);
});

test("the next test gets another one", () => {
  seen.push(dir());
  expect(new Set(seen).size).toBe(2);
});
