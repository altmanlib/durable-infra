import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fauxSetup, tempDirPerTest, toolDeps } from "../../testing/testing.ts";
import { builtinExtensions } from "../../testing/tools.ts";
import { AgentService } from "../index.ts";
import { messageText, splitSpeaker } from "./transcript.ts";

// Messages recorded without asking the model, such as what people say in a group.
const { faux, models, model } = fauxSetup({ tokensPerSecond: 100 });
const dir = tempDirPerTest("record-");
let service: AgentService | undefined;
const requests: TranscriptContext[] = [];

afterEach(async () => {
  await service?.close();
  service = undefined;
  requests.length = 0;
});

/** What the model saw of the user messages of a request: the speaker's id and the text. */
const users = (transcript: TranscriptContext | undefined) =>
  (transcript?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => {
      const spoken = splitSpeaker(message);
      return spoken ? `${spoken.speaker.id}: ${spoken.text}` : (messageText(message) ?? "");
    });

async function open(respond: (transcript: TranscriptContext) => AssistantMessage, count = 4) {
  faux.setResponses(
    Array.from({ length: count }, () => (transcript: TranscriptContext) => {
      requests.push(transcript);
      return respond(transcript);
    }),
  );
  service = await AgentService.open({
    databasePath: join(dir(), "agent.sqlite"),
    models,
    model,
    settings: { retry: { enabled: false } },
    extensions: (host) => builtinExtensions({ ...toolDeps({ now: () => new Date("2026-10-19T08:00:00Z") }), ...host }),
  });
  return service;
}

test("a recorded message asks the model nothing, shows in the history, and is context for the next question", async () => {
  const agents = await open(() => fauxAssistantMessage("ok"));
  await agents.record("feishu:oc_g", "the build is red", "fs:oc_g:om_1", { speaker: { id: "ou_a", name: "Ann" }, at: 1 });
  await agents.record("feishu:oc_g", "since the last merge", "fs:oc_g:om_2", { speaker: { id: "ou_b" } });
  expect(requests).toHaveLength(0);
  const history = await agents.history("feishu:oc_g", 10);
  expect(history).toEqual([
    { role: "user", text: "the build is red", speaker: { id: "ou_a", name: "Ann" } },
    { role: "user", text: "since the last merge", speaker: { id: "ou_b" } },
  ]);
  const turn = await agents.send("feishu:oc_g", "why?", "fs:oc_g:om_3", { speaker: { id: "ou_c" } });
  expect(await turn.answer).toBe("ok");
  expect(users(requests[0])).toEqual(["ou_a: the build is red", "ou_b: since the last merge", "ou_c: why?"]);
});

test("a message recorded twice under one request id is kept once", async () => {
  const agents = await open(() => fauxAssistantMessage("ok"));
  await agents.record("feishu:oc_g", "hello", "fs:oc_g:om_1", { speaker: { id: "ou_a" } });
  await agents.record("feishu:oc_g", "hello", "fs:oc_g:om_1", { speaker: { id: "ou_a" } });
  expect(await agents.history("feishu:oc_g", 10)).toHaveLength(1);
});

test("a message from a group's history is marked as backfill in its entry; a live one is not", async () => {
  const agents = await open(() => fauxAssistantMessage("ok"));
  await agents.record("feishu:oc_g", "said before", "fs:oc_g:om_1", { speaker: { id: "ou_a" }, at: 5, backfill: true });
  await agents.record("feishu:oc_g", "said now", "fs:oc_g:om_2", { speaker: { id: "ou_a" }, at: 6 });
  const data: unknown[] = [];
  for await (const id of agents.reader.conversations()) {
    for await (const entry of agents.reader.entries(id)) if (entry.kind === "chat.message") data.unshift(entry.data);
  }
  expect(data).toEqual([{ at: 5, backfill: true }, { at: 6 }]);
});

test("a message recorded while an answer runs reaches the model after the tool round, without a run of its own", async () => {
  const respond = (transcript: TranscriptContext): AssistantMessage =>
    transcript.messages.some((message) => message.role === "toolResult")
      ? fauxAssistantMessage(`final: ${"word ".repeat(30)}end.`)
      : fauxAssistantMessage([fauxText(`checking: ${"word ".repeat(30)}end.`), fauxToolCall("current_time", {}, { id: "call_1" })], { stopReason: "toolUse" });
  const agents = await open(respond);
  const turn = await agents.send("feishu:oc_g", "what time is it", "fs:oc_g:om_1", { speaker: { id: "ou_a" } });
  // The first generation is still streaming.
  await agents.record("feishu:oc_g", "meanwhile: lunch?", "fs:oc_g:om_2", { speaker: { id: "ou_b" } });
  await turn.answer;
  expect(requests).toHaveLength(2);
  expect(users(requests[0])).toEqual(["ou_a: what time is it"]);
  expect(users(requests[1])).toEqual(["ou_a: what time is it", "ou_b: meanwhile: lunch?"]);
});
