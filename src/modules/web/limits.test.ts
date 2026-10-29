import { expect, test } from "bun:test";

import { HostGate } from "./limits.ts";

const never = new AbortController().signal;
const aborted = () => new Error("aborted");

test("hosts whose slot has passed are forgotten, so many hosts cannot grow the memory without bound", async () => {
  let now = 0;
  const gate = new HostGate(1_000, () => now, { maxHosts: 3 });
  for (const host of ["a", "b", "c"]) await gate.wait(host, never, aborted);
  expect(gate.size).toBe(3);
  now = 5_000;
  await gate.wait("d", never, aborted);
  expect(gate.size).toBe(1);
});

test("a host still inside its interval is kept and keeps its spacing", async () => {
  let now = 0;
  const gate = new HostGate(1_000, () => now, { maxHosts: 1 });
  await gate.wait("a", never, aborted);
  now = 10;
  const started = Date.now();
  // "a" is still inside its interval, so the sweep must not drop it; a second "a" waits out the rest.
  await gate.wait("b", never, aborted);
  expect(gate.size).toBe(2);
  const waited = gate.wait("a", AbortSignal.timeout(50), aborted);
  expect(
    await waited.then(
      () => "went",
      (error: Error) => error.message,
    ),
  ).toBe("aborted");
  expect(Date.now() - started).toBeLessThan(1_000);
});
