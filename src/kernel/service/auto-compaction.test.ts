import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fauxSetup, tempDirPerTest } from "../../testing/testing.ts";
import { AgentService } from "../index.ts";
import { messageText } from "./transcript.ts";

// A small window so a handful of turns crosses the threshold `contextWindow - reserveTokens`.
const { faux, models, model } = fauxSetup({ id: "small", contextWindow: 1500, maxTokens: 500, tokensPerSecond: 2000 });

let summaryCalls = 0;

function respond(transcript: TranscriptContext): AssistantMessage {
  const first = transcript.messages[0];
  if (first?.role === "system" && typeof first.content === "string" && first.content.includes("summarization")) {
    summaryCalls++;
    return fauxAssistantMessage("## Summary\ntest summary");
  }
  const user = transcript.messages.findLast((message) => message.role === "user");
  return fauxAssistantMessage(`answer to ${messageText(user) ?? ""}: ${"word ".repeat(120)}end`);
}

const dir = tempDirPerTest("auto-compaction-");
let service: AgentService;

const open = (compaction: { enabled?: boolean }) =>
  AgentService.open({
    databasePath: join(dir(), "agent.sqlite"),
    models,
    model,
    settings: { retry: { enabled: false }, compaction: { reserveTokens: 300, keepRecentTokens: 100, backgroundTokens: 0, ...compaction } },
  });

async function chat(turns: number): Promise<void> {
  for (let n = 1; n <= turns; n++) await (await service.send("k", `question ${n}`, `r${n}`)).answer;
}

beforeEach(() => {
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  summaryCalls = 0;
});

afterEach(async () => {
  await service.close();
});

test("a long conversation is compacted automatically and keeps answering", async () => {
  service = await open({});
  await chat(12);
  expect(summaryCalls).toBeGreaterThan(0);
  const turn = await service.send("k", "still there?", "last");
  expect((await turn.answer).startsWith("answer to still there?")).toBe(true);
});

test("disabling automatic compaction stops summaries while the context grows", async () => {
  service = await open({ enabled: false });
  await chat(12);
  expect(summaryCalls).toBe(0);
});
