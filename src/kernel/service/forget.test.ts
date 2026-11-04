import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { captureLogs, fauxSetup, tempDirPerTest, toolDeps } from "../../testing/testing.ts";
import { builtinExtensions } from "../../testing/tools.ts";
import { AgentService, isEvent } from "../index.ts";

const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("forget-");

let service: AgentService | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
});

const open = async () => {
  service = await AgentService.open({
    databasePath: join(dir(), "agent.sqlite"),
    models,
    model,
    settings: { retry: { enabled: false } },
    extensions: (host) => builtinExtensions(toolDeps({ ...host })),
  });
  return service;
};

const ROOM = "room:A";
const OTHER = "room:B";
const all = () => true;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await condition()); i++) await sleep(10);
};
const say = async (s: AgentService, key: string, text: string, requestId: string) => {
  faux.setResponses([fauxAssistantMessage(`re: ${text}`)]);
  return (await s.send(key, text, requestId)).answer;
};

test("a forgotten key has no conversation: its history is gone, and the next send starts a new one without the old context", async () => {
  const s = await open();
  await say(s, ROOM, "walrus", "r1");
  await say(s, OTHER, "other", "r1");
  expect(await s.history(ROOM, 10)).toHaveLength(2);

  await s.forget(ROOM);
  expect(await s.history(ROOM, 10)).toEqual([]);
  expect(await s.reader.conversationOf(ROOM)).toBeUndefined();
  expect(await s.history(OTHER, 10)).toHaveLength(2);

  let seen: TranscriptContext | undefined;
  faux.setResponses([
    (transcript) => {
      seen = transcript;
      return fauxAssistantMessage("fresh");
    },
  ]);
  await (
    await s.send(ROOM, "second", "r2")
  ).answer;
  expect(JSON.stringify(seen?.messages)).not.toContain("walrus");
  expect((await s.history(ROOM, 10)).map((line) => line.text)).toEqual(["second", "fresh"]);
});

test("forgetting drops the key's undelivered inputs and notices and leaves the other keys' alone", async () => {
  const s = await open();
  await say(s, ROOM, "a", "r1");
  await say(s, OTHER, "b", "r1");
  await s.schedule(ROOM, Date.now() - 1000, { kind: "k", data: "a" });
  await s.schedule(OTHER, Date.now() - 1000, { kind: "k", data: "b" });
  await until(async () => (await s.notices(all)).length === 2);

  await s.forget(ROOM);
  expect((await s.pending(all)).map((item) => item.key)).toEqual([OTHER]);
  expect((await s.notices(all)).map((notice) => notice.key)).toEqual([OTHER]);
});

test("a scheduled event of the forgotten key never fires, one of another key still does", async () => {
  const s = await open();
  await say(s, ROOM, "a", "r1");
  await s.schedule(ROOM, Date.now() + 300, { kind: "k", data: "doomed" });
  await s.schedule(OTHER, Date.now() + 300, { kind: "k", data: "kept" });

  await s.forget(ROOM);
  await until(async () => (await s.notices(all)).length > 0);
  await sleep(300);
  expect((await s.notices(all)).filter(isEvent).map((notice) => [notice.key, notice.event.data])).toEqual([[OTHER, "kept"]]);
});

test("a reminder set in the forgotten conversation never fires", async () => {
  const s = await open();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("set_reminder", { at: new Date(Date.now() + 400).toISOString(), text: "stretch" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("set"),
  ]);
  await (
    await s.send(ROOM, "remind me", "r1")
  ).answer;

  await s.forget(ROOM);
  await sleep(800);
  expect(await s.notices(all)).toEqual([]);
});

test("forgetting an unknown key, or the same key twice, does nothing and is not an error", async () => {
  const s = await open();
  await s.forget("room:never");
  await say(s, ROOM, "a", "r1");
  const lines = await captureLogs(async () => {
    await s.forget(ROOM);
    await s.forget(ROOM);
  });
  expect(lines.filter(({ level }) => level === "error")).toEqual([]);
  expect(await s.history(ROOM, 10)).toEqual([]);
});

test("the forgetting survives a restart: the key stays without a conversation", async () => {
  let s = await open();
  await say(s, ROOM, "a", "r1");
  await s.forget(ROOM);
  await s.close();
  service = undefined;
  s = await open();
  expect(await s.reader.conversationOf(ROOM)).toBeUndefined();
  expect(await s.history(ROOM, 10)).toEqual([]);
});
