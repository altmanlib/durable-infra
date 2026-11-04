import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";

import { captureLogs, fauxSetup, tempDirPerTest } from "../../testing/testing.ts";
import { AgentService, type AgentServiceOptions } from "../index.ts";

const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("tool-filter-");
let service: AgentService | undefined;

/** Names of the tools each request announced, in request order. */
let offered: string[][] = [];
/** Tool calls that ran, by tool name. */
let ran: string[] = [];
/** Text of every tool result the model was given. */
let results: string[] = [];
let script: (transcript: TranscriptContext) => AssistantMessage;

const NAMES = ["alpha", "beta", "gamma"];

const tool = (name: string) =>
  defineTool({
    name,
    description: `Test tool ${name}`,
    parameters: obj({}, { open: true }),
    replay: "safe",
    execute: async () => {
      ran.push(name);
      return { output: [{ type: "text", text: `${name} ran` }] };
    },
  });

/** The tools a request offers: declared by its system messages, a later one removing or adding some. */
function toolsOf(transcript: TranscriptContext): string[] {
  const names = new Set<string>();
  for (const message of transcript.messages) {
    if (message.role !== "system") continue;
    for (const each of message.toolsRemoved ?? []) names.delete(each.name);
    for (const each of message.toolsAdded ?? []) names.add(each.name);
  }
  return [...names].sort();
}

const answerOk = () => fauxAssistantMessage("ok");

/** Calls `name` once, then answers. */
const callOnce =
  (name: string) =>
  (transcript: TranscriptContext): AssistantMessage =>
    transcript.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("done") : fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" });

beforeEach(() => {
  offered = [];
  ran = [];
  results = [];
  script = answerOk;
  faux.setResponses(
    Array.from({ length: 20 }, () => (transcript: TranscriptContext) => {
      offered.push(toolsOf(transcript));
      const last = transcript.messages.at(-1);
      if (last?.role === "toolResult") results.push(last.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
      return script(transcript);
    }),
  );
});

afterEach(async () => {
  await service?.close();
  service = undefined;
});

const open = (options: Partial<AgentServiceOptions> = {}, databasePath = join(dir(), "agent.sqlite")) =>
  AgentService.open({
    databasePath,
    models,
    model,
    settings: { retry: { enabled: false } },
    extensions: () => [defineExtension({ name: "test-tools", tools: NAMES.map(tool) })],
    ...options,
  });

const ask = async (key: string, requestId: string, options?: Parameters<AgentService["send"]>[3]) =>
  (await (service as AgentService).send(key, "hi", requestId, options)).answer;

test("without a selector every conversation is offered every tool", async () => {
  service = await open();
  await ask("a", "r1");
  await ask("b", "r2", { shared: true });
  expect(offered).toEqual([NAMES, NAMES]);
});

test("the model is offered only the tools the selector allows for its conversation", async () => {
  const allowed: Record<string, string[]> = { "chat:1": ["alpha"], "chat:2": ["beta", "gamma"], "chat:3": [] };
  service = await open({ allowedTools: (key) => allowed[key] });
  for (const [index, key] of Object.keys(allowed).entries()) await ask(key, `r${index}`);
  await ask("chat:4", "r9");
  expect(offered).toEqual([["alpha"], ["beta", "gamma"], [], NAMES]);
});

test("the selector may be async and return a set; names of tools that are not installed are ignored", async () => {
  service = await open({ allowedTools: async () => new Set(["gamma", "nowhere"]) });
  await ask("a", "r1");
  expect(offered).toEqual([["gamma"]]);
});

test("a change of the selector's answer applies from the next input, and an undefined answer lifts the restriction", async () => {
  let current: string[] | undefined = ["alpha"];
  service = await open({ allowedTools: () => current });
  await ask("a", "r1");
  current = ["beta"];
  await ask("a", "r2");
  current = ["alpha", "beta"];
  await ask("a", "r3");
  current = undefined;
  await ask("a", "r4");
  expect(offered).toEqual([["alpha"], ["beta"], ["alpha", "beta"], NAMES]);
});

test("a call to a tool the conversation is not offered is refused to the model and never runs", async () => {
  service = await open({ allowedTools: () => ["alpha"] });
  script = callOnce("beta");
  expect(await ask("a", "r1")).toBe("done");
  expect(ran).toEqual([]);
  expect(results).toHaveLength(1);
  expect(results[0]).toContain("beta");
  expect(results[0]).toContain("not available");
});

test("a call to an allowed tool runs", async () => {
  service = await open({ allowedTools: () => ["beta"] });
  script = callOnce("beta");
  await ask("a", "r1");
  expect(ran).toEqual(["beta"]);
  expect(results).toEqual(["beta ran"]);
});

test("an empty selection tells the model it has no tools", async () => {
  service = await open({ allowedTools: () => [] });
  const requests: TranscriptContext[] = [];
  faux.setResponses([
    (transcript) => {
      requests.push(transcript);
      return fauxAssistantMessage("ok");
    },
  ]);
  await ask("a", "r1");
  expect(JSON.stringify(requests[0]?.messages.filter((message) => message.role === "system"))).toContain("You have no tools");
});

test("the selection holds across a restart until the next input asks again", async () => {
  const databasePath = join(dir(), "agent.sqlite");
  let current: string[] | undefined = ["alpha"];
  service = await open({ allowedTools: () => current }, databasePath);
  await ask("a", "r1");
  await service.close();
  current = ["beta"];
  service = await open({ allowedTools: () => current }, databasePath);
  await ask("a", "r2");
  expect(offered).toEqual([["alpha"], ["beta"]]);
});

test("a shared conversation is narrowed within its shared tools, and a lifted restriction gives back all of them", async () => {
  let current: string[] | undefined = ["alpha", "gamma"];
  service = await open({ sharedTools: ["alpha", "beta"], allowedTools: () => current });
  await ask("g", "r1", { shared: true });
  current = ["alpha", "beta", "gamma"];
  await ask("g", "r2");
  current = ["beta"];
  await ask("g", "r3");
  current = undefined;
  await ask("g", "r4");
  expect(offered).toEqual([["alpha"], ["alpha", "beta"], ["beta"], ["alpha", "beta"]]);
});

test("the narrowed list is stored with the conversation: a restart does not undo it, shared or not", async () => {
  const databasePath = join(dir(), "agent.sqlite");
  service = await open({ sharedTools: ["alpha", "beta"], allowedTools: () => ["beta"] }, databasePath);
  await ask("g", "r1", { shared: true });
  await ask("p", "r2");
  await service.close();
  service = await open({ sharedTools: ["alpha", "beta"] }, databasePath);
  await ask("g", "r3");
  await ask("p", "r4");
  expect(offered).toEqual([["beta"], ["beta"], ["beta"], ["beta"]]);
});

test("a replay of an accepted input does not ask the selector again", async () => {
  const asked: string[] = [];
  service = await open({
    allowedTools: (key) => {
      asked.push(key);
      return ["alpha"];
    },
  });
  await ask("a", "r1");
  await ask("a", "r1");
  expect(asked).toEqual(["a"]);
});

test("a selector that fails refuses the input before it is recorded, and logs why", async () => {
  service = await open({
    allowedTools: () => {
      throw new Error("database unavailable");
    },
  });
  const lines = await captureLogs(async () => {
    await expect((service as AgentService).send("a", "hi", "r1")).rejects.toThrow("database unavailable");
  });
  expect(await service.pending(() => true)).toEqual([]);
  expect(offered).toEqual([]);
  expect(lines.some((entry) => entry.level === "error" && entry.line.includes("agent.allowed_tools_failed"))).toBe(true);
});

test("scheduling an event is not a turn: the selector is not asked", async () => {
  const asked: string[] = [];
  service = await open({
    allowedTools: (key) => {
      asked.push(key);
      return undefined;
    },
  });
  await service.schedule("a", Date.now() + 60_000, { kind: "ping", data: "" });
  expect(asked).toEqual([]);
});
