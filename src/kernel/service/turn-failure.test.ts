import { expect, test } from "bun:test";

import { classifyTurnFailure, turnFailureDetail } from "./turn-failure.ts";

test("timeout wording becomes provider_timeout", () => {
  expect(classifyTurnFailure("model_error", "Request timed out after 60000ms")).toBe("provider_timeout");
  expect(classifyTurnFailure("interrupted", "APIConnectionTimeoutError")).toBe("provider_timeout");
  expect(classifyTurnFailure("model_error", "Connect Timeout Error (ETIMEDOUT)")).toBe("provider_timeout");
});

test("connection wording becomes provider_unreachable", () => {
  expect(classifyTurnFailure("model_error", "fetch failed")).toBe("provider_unreachable");
  expect(classifyTurnFailure("model_error", "connect ECONNREFUSED 127.0.0.1:443")).toBe("provider_unreachable");
  expect(classifyTurnFailure("interrupted", "getaddrinfo ENOTFOUND api.example.com")).toBe("provider_unreachable");
});

test("other model failures keep their reason", () => {
  expect(classifyTurnFailure("model_error", "boom")).toBe("model_error");
  expect(classifyTurnFailure("interrupted", "host cut off")).toBe("interrupted");
  expect(classifyTurnFailure("rate_limited")).toBe("rate_limited");
  expect(classifyTurnFailure("aborted", "timeout")).toBe("aborted");
});

test("turnFailureDetail trims and truncates", () => {
  expect(turnFailureDetail(undefined)).toBeUndefined();
  expect(turnFailureDetail("  hi  ")).toBe("hi");
  expect(turnFailureDetail("x".repeat(10), 4)).toBe("xxxx…");
  expect(turnFailureDetail(new Error("nope"))).toBe("nope");
});
