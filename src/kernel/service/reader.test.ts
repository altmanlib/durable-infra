import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, type EntryRecord, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { fauxSetup, tempDirPerTest } from "../../testing/testing.ts";
import { SessionReader } from "./reader.ts";

const context = BACKGROUND_CONTEXT;
const { faux, models, model } = fauxSetup({ tokensPerSecond: 4000 });
const dir = tempDirPerTest("reader-");
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close(context);
  harness = undefined;
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

test("each entry is read once: a fork lists only what it appended itself", async () => {
  const storage = await openNodeSqliteStorage(join(dir(), "agent.sqlite"));
  harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { retry: { enabled: false } } }, context);
  faux.setResponses([() => fauxAssistantMessage("first"), () => fauxAssistantMessage("second")]);
  const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  await (await parent.submit({ type: "input", content: "one" }, context)).wait(context);
  const answered = (await parent.entries({}, 10, undefined, context)).items.find((entry) => AssistantEntry.is(entry));
  if (!answered) throw new Error("no answer to fork from");
  const child = await parent.fork(answered.id, { ownership: { kind: "ownerless" } }, context);
  await (await child.submit({ type: "input", content: "two" }, context)).wait(context);

  const reader = new SessionReader(harness, storage);
  expect(await collect(reader.conversations())).toEqual([parent.id, child.id]);
  const assistantTexts = async (id: typeof parent.id) =>
    (await collect<EntryRecord>(reader.entries(id))).filter((entry) => AssistantEntry.is(entry)).map((entry) => JSON.stringify(entry.model?.[0]));
  expect(await assistantTexts(parent.id)).toHaveLength(1);
  const childAnswers = await assistantTexts(child.id);
  expect(childAnswers).toHaveLength(1);
  expect(childAnswers[0]).toContain("second");
});
