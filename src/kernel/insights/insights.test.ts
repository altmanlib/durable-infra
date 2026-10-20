import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { type AssistantMessage, type TranscriptContext, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { fauxSetup, tempDirPerTest } from "../../testing/testing.ts";
import { AgentService, Insights, QueryError } from "../index.ts";
import { messageText } from "../service/transcript.ts";

const { faux, models, model } = fauxSetup({ tokensPerSecond: 4000 });

const SPEND = { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const spender = defineTool({
  name: "spender",
  description: "A tool with its own model spend",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async () => ({ output: [{ type: "text", text: "spent" }], usage: SPEND }),
});

function respond(transcript: TranscriptContext): AssistantMessage {
  const first = transcript.messages[0];
  if (first?.role === "system" && typeof first.content === "string" && first.content.includes("summarization")) {
    return fauxAssistantMessage("## Summary\ntest summary");
  }
  const user = transcript.messages.findLast((message) => message.role === "user");
  const called = transcript.messages.some((message) => message.role === "toolResult");
  if (!called && messageText(user) === "spend") return fauxAssistantMessage(fauxToolCall("spender", {}), { stopReason: "toolUse" });
  return fauxAssistantMessage(`answer ${"word ".repeat(80)}end`);
}

const dir = tempDirPerTest("insights-");
let service: AgentService;

beforeEach(async () => {
  faux.setResponses(Array.from({ length: 50 }, () => respond));
  service = await AgentService.open({
    databasePath: join(dir(), "agent.sqlite"),
    models,
    model,
    settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 50 } },
    extensions: () => [defineExtension({ name: "spending", tools: [spender] })],
  });
});

afterEach(async () => {
  await service.close();
});

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

test("usage adds up model responses and tool spend by day, and the open range matches Durable's total", async () => {
  await (await service.send("a", "hello", "r1")).answer;
  await (await service.send("b", "spend", "r2")).answer;
  expect(await service.compact("a")).toBe("compacted");

  const report = await new Insights(service.reader, { timeZone: "UTC" }).usage();
  expect(report.days).toHaveLength(1);
  const day = report.days[0];
  expect(day?.date).toBe(new Date().toISOString().slice(0, 10));
  expect(day?.sources.map((source) => `${source.kind}:${source.name}`)).toEqual(["model:faux/test", "tool:spender"]);
  expect(day?.sources[1]).toMatchObject({ input: 120, output: 30, totalTokens: 150 });
  // The compaction summary is in Durable's ledger but on no entry: it shows as undated, and the totals agree.
  expect(report.undated?.input).toBeGreaterThan(0);
  const ledger = await service.reader.usage();
  const counted = sum([...Object.values(ledger.models), ...Object.values(ledger.tools)].map((usage) => usage.totalTokens));
  expect(report.total.totalTokens).toBe(counted);
});

test("today is resolved in the report time zone", async () => {
  await (await service.send("a", "hello", "r1")).answer;
  const now = () => new Date();
  const manila = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(now());
  const report = await new Insights(service.reader, { timeZone: "Asia/Manila", now }).usage({ from: "today", to: "today" });
  expect(report).toMatchObject({ from: manila, to: manila, timeZone: "Asia/Manila" });
  expect(report.days.map((day) => day.date)).toEqual([manila]);

  const tomorrow = () => new Date(Date.now() + 86_400_000);
  const empty = await new Insights(service.reader, { timeZone: "Asia/Manila", now: tomorrow }).usage({ from: "today" });
  expect(empty.days).toEqual([]);
  expect(empty.undated).toBeUndefined();
});

test("malformed or reversed dates are the caller's mistake", async () => {
  const insights = new Insights(service.reader, { timeZone: "UTC" });
  await expect(insights.usage({ from: "2026-13-01" })).rejects.toBeInstanceOf(QueryError);
  await expect(insights.usage({ from: "2026-10-06", to: "2026-10-05" })).rejects.toBeInstanceOf(QueryError);
});
