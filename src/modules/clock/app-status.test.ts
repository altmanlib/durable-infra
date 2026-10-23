import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { AgentService } from "../../kernel/index.ts";
import { formatLocal } from "../../platform/local-time.ts";
import { fauxSetup, tempDirPerTest, toolDeps } from "../../testing/testing.ts";
import { builtinExtensions, builtinTools } from "../../testing/tools.ts";

const STARTED = new Date("2026-10-13T01:12:03Z");
const UPTIME_SECONDS = 11_520;
const NOW = new Date(STARTED.getTime() + UPTIME_SECONDS * 1000);
const deps = toolDeps({ now: () => NOW, startedAt: STARTED, version: "1.2.3" });

const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("app-status-");
let service: AgentService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

/** Calls `app_status` once, then quotes the result's code and text back. */
function askStatusThenQuote(transcript: TranscriptContext): AssistantMessage {
  const result = transcript.messages.findLast((message) => message.role === "toolResult");
  if (result === undefined) return fauxAssistantMessage(fauxToolCall("app_status", {}), { stopReason: "toolUse" });
  const code = (result.details as { code?: string } | undefined)?.code ?? "";
  const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return fauxAssistantMessage(`${code}\n${body}`);
}

test("app_status reports the version, the start time and the uptime of the injected clock", async () => {
  faux.setResponses([askStatusThenQuote, askStatusThenQuote]);
  service = await AgentService.open({
    databasePath: join(dir(), "agent.sqlite"),
    models,
    model,
    settings: { retry: { enabled: false } },
    extensions: (host) => builtinExtensions({ ...deps, ...host }),
  });
  const answer = await (await service.send("k", "when did you start", "r1")).answer;
  expect(answer.split("\n")[0]).toBe("reported");
  expect(answer).toContain("1.2.3");
  expect(answer).toContain(formatLocal(STARTED));
  expect(answer).not.toContain(STARTED.toISOString());
  expect(answer).toContain(String(UPTIME_SECONDS));
});

test("app_status is offered next to current_time and is read-only", () => {
  const tools = builtinTools(deps);
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["current_time", "app_status"]));
  expect(tools.find((tool) => tool.name === "app_status")?.replay).toBe("safe");
});
