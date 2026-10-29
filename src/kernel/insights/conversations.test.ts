import { afterEach, expect, test } from "bun:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

import { type LedgeredService, openLedgered } from "../../testing/ledger.ts";
import { fauxSetup, tempDirPerTest } from "../../testing/testing.ts";

// Slow enough that a test can look while an answer is being written.
const { faux, models, model } = fauxSetup({ tokensPerSecond: 20 });
const dir = tempDirPerTest("conversations-");

const opened: LedgeredService[] = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});

async function open(name = "conv"): Promise<LedgeredService> {
  const ledgered = await openLedgered({ databasePath: `${dir()}/${name}.sqlite`, models, model, settings: { retry: { enabled: false } } });
  opened.push(ledgered);
  return ledgered;
}

test("with nothing said there is nothing to list", async () => {
  expect((await (await open()).insights().conversations()).items).toEqual([]);
});

test("a conversation shows its key, when it was last active, what it spent, and what is still undelivered", async () => {
  const { service, insights } = await open();
  faux.setResponses([fauxAssistantMessage("hello there")]);
  const before = Date.now();
  const turn = await service.send("feishu:1001", "hi", "r1");
  await turn.answer;
  const [info, ...rest] = (await insights().conversations()).items;
  expect(rest).toEqual([]);
  expect(info).toMatchObject({ key: "feishu:1001", busy: false, pending: 1 });
  expect(info?.lastActiveAt).toBeGreaterThanOrEqual(before - 1000);
  expect(info?.lastActiveAt).toBeLessThanOrEqual(Date.now() + 1000);
  expect(info?.totalTokens).toBeGreaterThan(0);
  await service.delivered("feishu:1001", "r1");
  expect((await insights().conversations()).items[0]?.pending).toBe(0);
});

test("the one active most recently comes first", async () => {
  const { service, insights } = await open();
  // Built when asked for, so each answer carries the time it was written, not the time the test was set up.
  faux.setResponses([() => fauxAssistantMessage("a"), () => fauxAssistantMessage("b"), () => fauxAssistantMessage("c")]);
  await (
    await service.send("feishu:1", "one", "r1")
  ).answer;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await (
    await service.send("feishu:2", "two", "r1")
  ).answer;
  expect((await insights().conversations()).items.map((info) => info.key)).toEqual(["feishu:2", "feishu:1"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await (
    await service.send("feishu:1", "again", "r2")
  ).answer;
  expect((await insights().conversations()).items.map((info) => info.key)).toEqual(["feishu:1", "feishu:2"]);
});

test("while an answer is being written the conversation is busy, and after it is not", async () => {
  const { service, insights } = await open();
  faux.setResponses([fauxAssistantMessage("a long enough answer that it takes a moment to write out")]);
  const turn = await service.send("feishu:1", "go", "r1");
  expect((await insights().conversations()).items[0]?.busy).toBe(true);
  await turn.answer;
  expect((await insights().conversations()).items[0]?.busy).toBe(false);
});

test("a reset keeps the conversation in the list, and abort ends a busy one", async () => {
  const { service, insights } = await open();
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("a long enough answer that it takes a moment to write out")]);
  await (
    await service.send("feishu:1", "hi", "r1")
  ).answer;
  await service.reset("feishu:1");
  expect((await insights().conversations()).items.map((info) => info.key)).toEqual(["feishu:1"]);
  const turn = await service.send("feishu:1", "go", "r2");
  expect((await insights().conversations()).items[0]?.busy).toBe(true);
  await service.abort("feishu:1");
  await turn.answer.catch(() => undefined);
  await service.waitForIdle();
  expect((await insights().conversations()).items[0]?.busy).toBe(false);
});
