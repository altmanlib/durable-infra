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
  await (
    await service.send("a", "hello", "r1")
  ).answer;
  await (
    await service.send("b", "spend", "r2")
  ).answer;
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
  await (
    await service.send("a", "hello", "r1")
  ).answer;
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

test("usage of one channel key counts that key's conversations alone, and the keys add up to the whole", async () => {
  await (
    await service.send("a", "hello", "r1")
  ).answer;
  await (
    await service.send("b", "spend", "r2")
  ).answer;
  expect(await service.compact("a")).toBe("compacted");
  const insights = new Insights(service.reader, { timeZone: "UTC" });

  const [a, b, all] = [await insights.usage({}, { key: "a" }), await insights.usage({}, { key: "b" }), await insights.usage()];
  const sources = (report: typeof a) => report.days.flatMap((day) => day.sources.map((source) => `${source.kind}:${source.name}`));
  expect(sources(a)).toEqual(["model:faux/test"]);
  expect(sources(b)).toEqual(["model:faux/test", "tool:spender"]);
  // The compaction summary was a's: it is a's undated spend and not b's.
  expect(a.undated?.totalTokens).toBeGreaterThan(0);
  expect(b.undated?.totalTokens).toBe(0);
  expect(a.total.totalTokens + b.total.totalTokens).toBe(all.total.totalTokens);
});

test("usage of a key with no conversation is an empty report", async () => {
  await (
    await service.send("a", "hello", "r1")
  ).answer;
  const report = await new Insights(service.reader, { timeZone: "UTC" }).usage({}, { key: "nobody" });
  expect(report.days).toEqual([]);
  expect(report.total.totalTokens).toBe(0);
});

test("the empty key names no conversation: it asks for nothing, not for everything", async () => {
  await (
    await service.send("a", "hello", "r1")
  ).answer;
  const report = await new Insights(service.reader, { timeZone: "UTC" }).usage({}, { key: "" });
  expect(report.days).toEqual([]);
  expect(report.total.totalTokens).toBe(0);
});

test("spentOf reads one key's cumulative spend, never another key's, and an unknown key has none", async () => {
  await (
    await service.send("a", "hello", "r1")
  ).answer;
  await (
    await service.send("b", "spend", "r2")
  ).answer;
  expect(await service.compact("a")).toBe("compacted");
  const insights = new Insights(service.reader, { timeZone: "UTC" });

  const [a, b] = [await insights.spentOf("a"), await insights.spentOf("b")];
  expect(Object.keys(a?.models ?? {})).toEqual(["faux/test"]);
  expect(a?.tools).toEqual({});
  expect(b?.tools.spender).toMatchObject({ input: 120, output: 30, totalTokens: 150 });
  // The compaction summary is in a's ledger.
  const ledger = (await insights.usage({}, { key: "a" })).total.totalTokens;
  expect(a?.total.totalTokens).toBe(ledger);
  expect((a?.total.totalTokens ?? 0) + (b?.total.totalTokens ?? 0)).toBe((await insights.usage()).total.totalTokens);
  expect(await insights.spentOf("nobody")).toBeUndefined();
  expect(await insights.spentOf("")).toBeUndefined();
});

test("spentOf only grows, and a replayed request id adds nothing", async () => {
  const insights = new Insights(service.reader, { timeZone: "UTC" });
  await (
    await service.send("a", "hello", "r1")
  ).answer;
  const first = (await insights.spentOf("a"))?.total.totalTokens ?? 0;
  expect(first).toBeGreaterThan(0);
  await (
    await service.send("a", "hello", "r1")
  ).answer;
  expect((await insights.spentOf("a"))?.total.totalTokens).toBe(first);
  await (
    await service.send("a", "again", "r2")
  ).answer;
  expect((await insights.spentOf("a"))?.total.totalTokens ?? 0).toBeGreaterThan(first);
});

test("the conversations are listed by key, most recent first, and are the same as the service lists", async () => {
  await (
    await service.send("a", "hello", "r1")
  ).answer;
  await (
    await service.send("b", "hello", "r2")
  ).answer;
  const listed = await new Insights(service.reader).conversations();
  expect(listed.map((info) => info.key).sort()).toEqual(["a", "b"]);
  expect(listed).toEqual(await service.conversations());
});
