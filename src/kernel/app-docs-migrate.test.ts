import { expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { tempDirPerTest } from "../testing/testing.ts";
import { appDoc, appDocFamily, checkpoint } from "./app-docs.ts";

// Changing the shape of an application document: the stored version is compared with the definition's. An older one is
// converted when read if the definition says how (`migrate`), and a commit stores it at the new version; an older one
// without `migrate`, or a newer one than the definition knows, throws on read, so old code never writes a newer store.

const dir = tempDirPerTest("app-docs-migrate-");
const open = async () =>
  Harness.open(await openNodeSqliteStorage(join(dir(), "agent.sqlite")), { models: createModels(), registry: createRegistry() }, context);

type V1 = { name: string };
type V2 = { first: string; last: string };
const split = (value: unknown): V2 => {
  const [first = "", last = ""] = String((value as V1).name).split(" ");
  return { first, last };
};

const single1 = appDoc<V1>({ kind: "app.shape", version: 1, initial: () => ({ name: "" }), checkpoint: checkpoint.every(50) });
const single2 = appDoc<V2>({ kind: "app.shape", version: 2, initial: () => ({ first: "", last: "" }), checkpoint: checkpoint.every(50), migrate: split });
const single2Bare = appDoc<V2>({ kind: "app.shape", version: 2, initial: () => ({ first: "", last: "" }), checkpoint: checkpoint.every(50) });
const family1 = appDocFamily<V1, string>({ kind: "app.shapes", version: 1, initial: (name) => ({ name }), checkpoint: checkpoint.every(50) });
const family2 = appDocFamily<V2, string>({
  kind: "app.shapes",
  version: 2,
  initial: () => ({ first: "", last: "" }),
  checkpoint: checkpoint.every(50),
  migrate: split,
});

test("an older stored document is migrated when read, singleton and family member alike, and stored at the new version by the next commit", async () => {
  let harness = await open();
  await harness.commit(async (tx) => {
    (await tx.doc(single1)).name = "Ada Lovelace";
    await tx.doc(family1, "k", "Grace Hopper");
  }, context);
  await harness.close(context);

  harness = await open();
  expect(await harness.snapshot(single2, context)).toEqual({ first: "Ada", last: "Lovelace" });
  expect(await harness.snapshot(family2, "k", context)).toEqual({ first: "Grace", last: "Hopper" });
  await harness.commit(async (tx) => {
    (await tx.doc(single2)).last = "King";
  }, context);
  await harness.close(context);

  harness = await open();
  expect(await harness.snapshot(single2, context)).toEqual({ first: "Ada", last: "King" });
  await harness.close(context);
});

test("an older document without migrate throws on read, and so does a newer one than the definition knows", async () => {
  let harness = await open();
  await harness.commit(async (tx) => {
    (await tx.doc(single1)).name = "Ada Lovelace";
  }, context);
  await harness.close(context);

  harness = await open();
  await expect(harness.snapshot(single2Bare, context)).rejects.toThrow();
  await harness.commit(async (tx) => {
    (await tx.doc(single2)).last = "King";
  }, context);
  await expect(harness.snapshot(single1, context)).rejects.toThrow();
  await harness.close(context);
});
