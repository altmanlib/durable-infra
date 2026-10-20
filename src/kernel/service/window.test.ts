import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fauxSetup, tempDirPerTest, toolDeps } from "../../testing/testing.ts";
import { builtinExtensions } from "../../testing/tools.ts";
import { AgentService } from "../index.ts";
import { messageText, splitSpeaker } from "./transcript.ts";

// The context window of a group: the oldest messages leave the model's context once there are too many (R038).
const { faux, models, model } = fauxSetup({ tokensPerSecond: 1000 });
const dir = tempDirPerTest("window-");
let service: AgentService | undefined;
const requests: TranscriptContext[] = [];

afterEach(async () => {
  await service?.close();
  service = undefined;
  requests.length = 0;
});

/** The text of every user message a request carried, in order. */
const users = (transcript: TranscriptContext | undefined) =>
  (transcript?.messages ?? []).filter((message) => message.role === "user").map((message) => splitSpeaker(message)?.text ?? messageText(message) ?? "");

async function open(respond: (transcript: TranscriptContext) => AssistantMessage = () => fauxAssistantMessage("ok")) {
  faux.setResponses(
    Array.from({ length: 10 }, () => (transcript: TranscriptContext) => {
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

async function recordMany(agents: AgentService, from: number, to: number) {
  for (let index = from; index <= to; index++) await agents.record("group", `m${index}`, `r${index}`, { speaker: { id: "ou_a" }, shared: true });
}

test("over keep + slack messages the context starts at the keep-th message from the end; up to it nothing moves", async () => {
  const agents = await open();
  await recordMany(agents, 1, 15);
  expect(await agents.keepRecent("group", 10, 5)).toBe("kept");
  await recordMany(agents, 16, 16);
  expect(await agents.keepRecent("group", 10, 5)).toBe("moved");
  // Asked again before anything new: there are 10 now, nothing to move.
  expect(await agents.keepRecent("group", 10, 5)).toBe("kept");
  await (await agents.send("group", "q1", "q1", { speaker: { id: "ou_b" }, shared: true })).answer;
  expect(users(requests[0])).toEqual(["m7", "m8", "m9", "m10", "m11", "m12", "m13", "m14", "m15", "m16", "q1"]);
  // The older ones stay in storage: the history still lists them.
  expect((await agents.history("group", 100)).map((line) => line.text)).toContain("m1");
});

test("a question counts as a message, the window moves again later, and what left never comes back", async () => {
  const agents = await open();
  await recordMany(agents, 1, 16);
  await agents.keepRecent("group", 10, 5);
  await (await agents.send("group", "q1", "q1", { shared: true })).answer;
  await recordMany(agents, 17, 21);
  expect(await agents.keepRecent("group", 10, 5)).toBe("moved");
  await (await agents.send("group", "q2", "q2", { shared: true })).answer;
  // m7..m16, q1, m17..m21 were 16; the newest 10 of them, then q2.
  expect(users(requests.at(-1))).toEqual(["m13", "m14", "m15", "m16", "q1", "m17", "m18", "m19", "m20", "m21", "q2"]);
});

test("the window never starts inside a tool round: the start is a user message, the round stays whole after it", async () => {
  const agents = await open((transcript) =>
    transcript.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage("it is morning")
      : fauxAssistantMessage(fauxToolCall("current_time", {}), { stopReason: "toolUse" }),
  );
  await recordMany(agents, 1, 12);
  await (await agents.send("group", "what time is it", "q1", { shared: true })).answer;
  await recordMany(agents, 13, 16);
  expect(await agents.keepRecent("group", 5, 0)).toBe("moved");
  await (await agents.send("group", "q2", "q2", { shared: true })).answer;
  const request = requests.at(-2);
  const roles = (request?.messages ?? []).filter((message) => message.role !== "system").map((message) => message.role);
  expect(roles[0]).toBe("user");
  expect(users(request)).toEqual(["what time is it", "m13", "m14", "m15", "m16", "q2"]);
  expect(roles).toContain("toolResult");
});
