import { afterEach, expect, test } from "bun:test";

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

import { captureLogs, fauxSetup, tempDirPerTest } from "../../testing/testing.ts";
import { AgentService } from "./agent-service.ts";
import { TIMERS_KEY } from "./timers.ts";

const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("thinking-level-");
const opened: AgentService[] = [];
const seen: (string | undefined)[] = [];

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
  seen.length = 0;
});

async function open(thinkingLevel?: ModelThinkingLevel): Promise<AgentService> {
  const service = await AgentService.open({
    databasePath: `${dir()}/agent.sqlite`,
    models,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    settings: { retry: { enabled: false } },
  });
  opened.push(service);
  return service;
}

const closeAll = async () => {
  while (opened.length > 0) await opened.pop()?.close();
};

/** Sends one message and records the reasoning level the provider was asked with. */
async function ask(service: AgentService, key: string, id: string): Promise<void> {
  faux.setResponses([
    (_context: unknown, options: { reasoning?: string } | undefined) => {
      seen.push(options?.reasoning);
      return fauxAssistantMessage("ok");
    },
  ]);
  await (
    await service.send(key, "hi", id)
  ).answer;
}

const switched = (lines: { line: string }[]) => lines.filter((entry) => entry.line.includes("agent.thinking_level_switched"));

test("every conversation asks with the configured thinking level after the service opens with another, reset or not", async () => {
  const first = await open("minimal");
  await ask(first, "chat:1", "r1");
  await closeAll();

  const second = await open();
  await second.reset("chat:1");
  await ask(second, "chat:1", "r2");
  await ask(second, "chat:2", "r3");
  expect(seen).toEqual(["minimal", "low", "low"]);
});

test("the move is logged once per conversation, and a second open moves nothing", async () => {
  const first = await open("minimal");
  await ask(first, "chat:1", "r1");
  await ask(first, "chat:2", "r2");
  await closeAll();

  const lines = await captureLogs(async () => {
    await open();
  });
  expect(switched(lines)).toHaveLength(2);
  expect(switched(lines)[0]?.line).toContain("conversation=chat:1");
  expect(switched(lines)[0]?.line).toContain("from=minimal");
  expect(switched(lines)[0]?.line).toContain("to=low");
  await closeAll();

  expect(switched(await captureLogs(async () => void (await open())))).toEqual([]);
});

test("a service that keeps its level moves nothing, and the timers conversation follows the level", async () => {
  const first = await open("minimal");
  await ask(first, "chat:1", "r1");
  await first.schedule("chat:1", Date.now() + 3_600_000, { kind: "test", data: "" });
  await closeAll();

  expect(switched(await captureLogs(async () => void (await open("minimal"))))).toEqual([]);
  await closeAll();

  const lines = await captureLogs(async () => void (await open("high")));
  expect(switched(lines).some((entry) => entry.line.includes(`conversation=${TIMERS_KEY}`))).toBe(true);
  expect(switched(lines)).toHaveLength(2);
});
