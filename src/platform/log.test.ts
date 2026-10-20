import { expect, test } from "bun:test";
import { formatLine, log, setLogSink } from "./log.ts";

const AT = new Date("2026-10-06T03:00:00.000Z");

test("a line is time, level, event and key=value fields in the order given", () => {
  expect(formatLine("info", "message.received", { requestId: "tg:1:42", chars: 5, group: false }, undefined, AT)).toBe(
    "2026-10-06T03:00:00.000Z info message.received requestId=tg:1:42 chars=5 group=false",
  );
});

test("values with spaces, quotes or equals signs are quoted, and undefined fields are left out", () => {
  const line = formatLine("warn", "x", { a: "two words", b: 'say "hi"', c: "k=v", d: undefined, e: null }, undefined, AT);
  expect(line).toBe('2026-10-06T03:00:00.000Z warn x a="two words" b="say \\"hi\\"" c="k=v" e=null');
});

test("an error contributes its message to the line", () => {
  expect(formatLine("error", "update.failed", { chatId: 7 }, new Error("storage down"), AT)).toBe(
    '2026-10-06T03:00:00.000Z error update.failed chatId=7 error="storage down"',
  );
  expect(formatLine("error", "x", {}, "plain text", AT)).toBe('2026-10-06T03:00:00.000Z error x error="plain text"');
});

test("lines go to the sink with their level and the original error, and the previous sink can be restored", () => {
  const seen: { line: string; level: string; error: unknown }[] = [];
  const previous = setLogSink((line, level, error) => void seen.push({ line, level, error }));
  try {
    const failure = new Error("boom");
    log.info("a.b", { n: 1 });
    log.warn("c.d");
    log.error("e.f", { n: 2 }, failure);
    expect(seen.map((entry) => entry.level)).toEqual(["info", "warn", "error"]);
    expect(seen[0]?.line).toMatch(/ info a\.b n=1$/);
    expect(seen[2]?.error).toBe(failure);
  } finally {
    setLogSink(previous);
  }
});
