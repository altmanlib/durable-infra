import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { formatLocal } from "../../platform/local-time.ts";
import { captureLogs, fauxSetup, tempDirPerTest, toolDeps } from "../../testing/testing.ts";
import { builtinExtensions, builtinTools } from "../../testing/tools.ts";
import { AgentService } from "../index.ts";

const NOW = new Date("2026-10-05T04:30:15Z");
const deps = toolDeps({ now: () => NOW });

const { faux, models, model } = fauxSetup();

let requests: TranscriptContext[] = [];

/** First request asks for the clock; the second quotes the tool result back. */
function askClockThenQuote(transcript: TranscriptContext): AssistantMessage {
  requests.push(transcript);
  const result = transcript.messages.findLast((message) => message.role === "toolResult");
  if (result === undefined) return fauxAssistantMessage(fauxToolCall("current_time", {}), { stopReason: "toolUse" });
  return fauxAssistantMessage(`the tool said: ${result.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`);
}

const dir = tempDirPerTest("tools-");
let service: AgentService | undefined;

const open = (toolDeps: Parameters<typeof builtinExtensions>[0] | undefined) =>
  AgentService.open({
    databasePath: join(dir(), "agent.sqlite"),
    models,
    model,
    settings: { retry: { enabled: false } },
    extensions: toolDeps === undefined ? undefined : (host) => builtinExtensions({ ...toolDeps, ...host }),
  });

/** Tool names the request announced; a transcript carries them on its system entries. */
const offeredTools = (request: TranscriptContext | undefined): string[] =>
  (request?.messages ?? []).flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []));

const systemText = (request: TranscriptContext | undefined): string =>
  (request?.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => JSON.stringify(message))
    .join("\n");

beforeEach(() => {
  requests = [];
  faux.setResponses(Array.from({ length: 20 }, () => askClockThenQuote));
});

afterEach(async () => {
  await service?.close();
  service = undefined;
});

test("a tool call round trip reaches the final answer with the tool's result", async () => {
  service = await open(deps);
  const answer = await (await service.send("k", "what time is it", "r1")).answer;
  expect(answer).toContain(formatLocal(NOW));
  expect(answer).not.toContain(NOW.toISOString());
  expect(requests).toHaveLength(2);
});

test("the request offers the tool and drops the no-tools notice", async () => {
  service = await open(deps);
  await (
    await service.send("k", "hi", "r1")
  ).answer;
  expect(offeredTools(requests[1])).toContain("current_time");
  expect(systemText(requests[1])).not.toContain("You have no tools");
});

test("without extensions the model is told it has no tools", async () => {
  service = await open(undefined);
  faux.setResponses([
    (transcript) => {
      requests.push(transcript);
      return fauxAssistantMessage("ok");
    },
  ]);
  await (
    await service.send("k", "hi", "r1")
  ).answer;
  expect(offeredTools(requests[0])).toEqual([]);
  expect(systemText(requests[0])).toContain("You have no tools");
});

test("every built-in tool declares its replay policy explicitly", () => {
  const tools = builtinTools(deps);
  expect(tools.length).toBeGreaterThan(0);
  for (const tool of tools) expect([tool.name, tool.replay]).toEqual([tool.name, expect.stringMatching(/^(safe|unsafe)$/)]);
});

async function activityOf(turn: { tools: AsyncIterable<{ callId: string; name: string; status: string }> }) {
  const seen: { callId: string; name: string; status: string }[] = [];
  for await (const activity of turn.tools) seen.push(activity);
  return seen;
}

test("a turn reports its tool calls, each call at most once per status, and the stream ends with the turn", async () => {
  service = await open(deps);
  const turn = await service.send("k", "what time is it", "r1");
  const [activity] = await Promise.all([activityOf(turn), turn.answer]);
  expect(activity.length).toBeGreaterThan(0);
  expect(activity.every((item) => item.name === "current_time")).toBe(true);
  expect(new Set(activity.map((item) => `${item.callId}/${item.status}`)).size).toBe(activity.length);
});

test("a turn without tool calls reports no tool activity", async () => {
  service = await open(undefined);
  faux.setResponses([() => fauxAssistantMessage("plain answer")]);
  const turn = await service.send("k", "hi", "r1");
  const [activity] = await Promise.all([activityOf(turn), turn.answer]);
  expect(activity).toEqual([]);
});

test("web_fetch reaches the fetcher, and the notice about outside content is only there when the tool is", async () => {
  const fetched: string[] = [];
  service = await open({
    ...deps,
    pages: {
      fetch: async (url: string) => {
        fetched.push(url);
        return { url, status: 200, title: "T", text: "page body", truncated: false, needsRendering: false };
      },
    },
  });
  faux.setResponses([() => fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://example.test/a" }), { stopReason: "toolUse" }), askClockThenQuote]);
  const answer = await (await service.send("k", "read it", "r1")).answer;
  expect(fetched).toEqual(["https://example.test/a"]);
  expect(answer).toContain("<web_page");
  expect(answer).toContain("page body");
  expect(systemText(requests.at(-1))).toContain("fetched from the internet");
});

test("without tools there is no notice about outside content", async () => {
  service = await open(undefined);
  faux.setResponses([
    (transcript) => {
      requests.push(transcript);
      return fauxAssistantMessage("ok");
    },
  ]);
  await (
    await service.send("k", "hi", "r1")
  ).answer;
  expect(systemText(requests[0])).not.toContain("fetched from the internet");
});

test("a finished turn is logged with its duration, tool calls and token use", async () => {
  service = await open(deps);
  const lines = await captureLogs(async () => {
    await (
      await (service as AgentService).send("k", "what time is it", "r1")
    ).answer;
  });
  const done = lines.find((entry) => entry.line.includes(" turn.done "))?.line ?? "";
  expect(done).toContain("key=k requestId=r1");
  expect(done).toMatch(/ ms=\d+ toolCalls=1 inputTokens=\d+ outputTokens=\d+$/);
});

test("a turn that fails is logged with its reason", async () => {
  service = await open(undefined);
  faux.setResponses([() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
  const lines = await captureLogs(async () => {
    await (await (service as AgentService).send("k", "hi", "r1")).answer.catch(() => {});
  });
  const failed = lines.find((entry) => entry.line.includes(" turn.failed "));
  expect(failed?.level).toBe("warn");
  expect(failed?.line).toContain("key=k requestId=r1 reason=");
});
