import { afterEach, expect, test } from "bun:test";

import { fauxSetup, tempDirPerTest } from "../../testing/testing.ts";
import { AgentService } from "../service/agent-service.ts";
import { SettingsError } from "./error.ts";

const { models, model } = fauxSetup();
const dir = tempDirPerTest("channel-store-");

const opened: AgentService[] = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});

async function open(name = "channel"): Promise<AgentService> {
  const service = await AgentService.open({ databasePath: `${dir()}/${name}.sqlite`, models, model, settings: { retry: { enabled: false } } });
  opened.push(service);
  return service;
}

async function reopen(service: AgentService, name: string): Promise<AgentService> {
  await service.close();
  opened.splice(opened.indexOf(service), 1);
  return open(name);
}

const fails = async (work: Promise<unknown>) =>
  (await work.then(
    () => undefined,
    (error: unknown) => error,
  )) as Error | undefined;

type Doc = { cursor: string; seen: string[] };
const fresh: Doc = { cursor: "", seen: [] };

test("a document that was never written reads as undefined, and one written is read back and survives a restart", async () => {
  const first = await open("persist");
  const store = first.settings.channel("feishu");
  expect(await store.read("docs", "u1")).toBeUndefined();
  await store.commit(async (tx) => {
    const doc = await tx.get<Doc>("docs", "u1", fresh);
    doc.cursor = "c1";
    doc.seen.push("m1");
  });
  expect(await store.read<Doc>("docs", "u1")).toEqual({ cursor: "c1", seen: ["m1"] });
  // The seed object the caller passed is not changed by the edit.
  expect(fresh).toEqual({ cursor: "", seen: [] });

  const second = await reopen(first, "persist");
  expect(await second.settings.channel("feishu").read<Doc>("docs", "u1")).toEqual({ cursor: "c1", seen: ["m1"] });
});

test("keys lists every key of one collection of one channel, sorted, past one page, and nothing else", async () => {
  const { settings } = await open();
  const feishu = settings.channel("feishu");
  const ids = Array.from({ length: 230 }, (_, i) => `u${i}`);
  await feishu.commit(async (tx) => {
    for (const id of ids) await tx.get("docs", id, fresh);
    await tx.get("lists", "all", { items: [] });
  });
  await settings.channel("other").commit(async (tx) => {
    await tx.get("docs", "foreign", fresh);
  });
  const keys = await feishu.keys("docs");
  expect(keys.length).toBe(230);
  expect(keys).toEqual([...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
  expect(await feishu.keys("lists")).toEqual(["all"]);
  expect(await settings.channel("other").keys("docs")).toEqual(["foreign"]);
  expect(await feishu.keys("nothing-here")).toEqual([]);
});

test("a retired document is no longer read or listed, and a later get starts again from the seed", async () => {
  const { settings } = await open();
  const store = settings.channel("feishu");
  await store.commit(async (tx) => {
    (await tx.get<Doc>("docs", "u1", fresh)).cursor = "old";
    await tx.get("docs", "u2", fresh);
  });
  await store.commit(async (tx) => tx.retire("docs", "u1"));
  expect(await store.read("docs", "u1")).toBeUndefined();
  expect(await store.keys("docs")).toEqual(["u2"]);
  await store.commit(async (tx) => {
    expect((await tx.get<Doc>("docs", "u1", fresh)).cursor).toBe("");
  });
});

test("a commit that throws changes nothing: not the documents, not the history", async () => {
  const { settings } = await open();
  const store = settings.channel("feishu");
  await store.commit(async (tx) => {
    (await tx.get<Doc>("docs", "u1", fresh)).cursor = "kept";
  });
  const historyBefore = (await settings.changes()).items.length;

  const error = await fails(
    store.commit(async (tx) => {
      (await tx.get<Doc>("docs", "u1", fresh)).cursor = "lost";
      await tx.get("docs", "u2", fresh);
      await tx.record({ target: "groups/2", before: null, after: "banned" });
      throw new Error("no good");
    }),
  );
  expect(error?.message).toBe("no good");
  expect((await store.read<Doc>("docs", "u1"))?.cursor).toBe("kept");
  expect(await store.keys("docs")).toEqual(["u1"]);
  expect((await settings.changes()).items.length).toBe(historyBefore);
});

test("a line recorded in a commit shows in the history at once, under the channel's name", async () => {
  const { settings } = await open();
  await settings.channel("feishu").commit(async (tx) => tx.record({ target: "groups/1", before: "allowed", after: "banned" }));
  expect((await settings.changes()).items[0]).toMatchObject({ area: "channel", target: "feishu/groups/1", before: "allowed", after: "banned" });
});

test("names and keys that could reach another channel or break a document kind are refused", async () => {
  const { settings } = await open();
  expect(() => settings.channel("Feishu")).toThrow(SettingsError);
  expect(() => settings.channel("a.b")).toThrow(SettingsError);
  expect(() => settings.channel("")).toThrow(SettingsError);
  const store = settings.channel("feishu");
  expect(await fails(store.read("Docs", "u1"))).toBeInstanceOf(SettingsError);
  expect(await fails(store.keys("docs.x"))).toBeInstanceOf(SettingsError);
  expect(await fails(store.commit(async (tx) => void (await tx.get("a/b", "u1", fresh))))).toBeInstanceOf(SettingsError);
  expect(await fails(store.read("docs", ""))).toBeInstanceOf(SettingsError);
  expect(await fails(store.read("docs", "k".repeat(201)))).toBeInstanceOf(SettingsError);
});

test("twenty commits at once on one document all land, each starting from what the one before left", async () => {
  const { settings } = await open();
  const store = settings.channel("feishu");
  await Promise.all(
    Array.from({ length: 20 }, () =>
      store.commit(async (tx) => {
        const doc = await tx.get<{ n: number }>("counters", "c", { n: 0 });
        const read = doc.n;
        await Bun.sleep(1);
        doc.n = read + 1;
      }),
    ),
  );
  expect((await store.read<{ n: number }>("counters", "c"))?.n).toBe(20);
});
