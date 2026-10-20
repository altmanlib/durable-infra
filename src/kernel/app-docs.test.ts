import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject, StoredDocument } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fauxSetup, tempDirPerTest } from "../testing/testing.ts";
import { AgentService } from "./index.ts";

// durable-bot R077: a document without a checkpoint keeps every change it ever had, and a read after a restart replays them all.

const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("app-docs-");
const path = () => join(dir(), "agent.sqlite");
let service: AgentService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

const answer = (transcript: TranscriptContext) => fauxAssistantMessage(`re ${transcript.messages.length}`);

/** What the storage holds for one document of `kind` (the only one, or the one at `key`): how a read would rebuild it. */
async function stored(kind: string, key = ""): Promise<StoredDocument> {
  const storage = await openNodeSqliteStorage(path());
  try {
    const page = await storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind }, 100, undefined, context);
    const record = page.items.find((item) => key === "" || item.key === key);
    if (!record) throw new Error(`no ${kind} ${key}`);
    const document = await storage.document(record.id, "current", context);
    if (!document) throw new Error(`no value for ${kind}`);
    return document;
  } finally {
    await storage.close(context);
  }
}

test("after many answered turns the outbox is one empty base: no past turn, and none of their texts, is replayed or kept", async () => {
  faux.setResponses(Array.from({ length: 60 }, () => answer));
  service = await AgentService.open({
    databasePath: path(),
    models,
    model,
    settings: { retry: { enabled: false } },
    rateLimit: { max: 1000, windowMs: 60_000 },
  });
  for (let turn = 1; turn <= 60; turn++) {
    await (await service.send("feishu:1", `secret ${turn}`, `r${turn}`)).answer;
    await service.delivered("feishu:1", `r${turn}`);
  }
  await service.close();
  service = undefined;
  const outbox = await stored("app.outbox");
  expect([outbox.deltasSinceBase, outbox.value]).toEqual([0, { items: [] }]);
});

test("an input still owed survives the checkpoints, and the outbox stays short to replay while it waits", async () => {
  faux.setResponses(Array.from({ length: 300 }, () => answer));
  service = await AgentService.open({
    databasePath: path(),
    models,
    model,
    settings: { retry: { enabled: false } },
    rateLimit: { max: 1000, windowMs: 60_000 },
  });
  // Never confirmed: it stays in the outbox while 120 other turns come and go.
  await (await service.send("terminal:owed", "still owed", "owed")).answer;
  for (let turn = 1; turn <= 120; turn++) {
    await (await service.send("feishu:1", `t ${turn}`, `r${turn}`)).answer;
    await service.delivered("feishu:1", `r${turn}`);
  }
  await service.close();
  service = undefined;
  const outbox = await stored("app.outbox");
  expect(outbox.deltasSinceBase).toBeLessThan(100);
  expect(outbox.value).toEqual({ items: [{ key: "terminal:owed", requestId: "owed", text: "still owed" }] });
  service = await AgentService.open({ databasePath: path(), models, model });
  expect(await service.pending((key) => key.startsWith("terminal:"))).toEqual([{ key: "terminal:owed", requestId: "owed", text: "still owed" }]);
});

test("a channel's document written on every message stays short to replay, and keeps its value", async () => {
  service = await AgentService.open({ databasePath: path(), models, model });
  const docs = service.settings.channel("feishu");
  for (let message = 1; message <= 130; message++) {
    await docs.commit(async (tx) => {
      const doc = await tx.get<{ cursor: string; seen: string[] } & JsonObject>("accounts", "u1", { cursor: "", seen: [] });
      doc.cursor = `c${message}`;
      doc.seen.push(`m${message}`);
      if (doc.seen.length > 20) doc.seen.splice(0, doc.seen.length - 20);
    });
  }
  await service.close();
  service = undefined;
  const account = await stored("app.channel.feishu.accounts", "u1");
  expect(account.deltasSinceBase).toBeLessThan(50);
  expect(account.value).toMatchObject({ cursor: "c130", seen: Array.from({ length: 20 }, (_, index) => `m${111 + index}`) });
});
