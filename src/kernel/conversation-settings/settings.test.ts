import { afterEach, expect, test } from "bun:test";

import { Records } from "../../platform/records/records.ts";
import { captureLogs } from "../../testing/testing.ts";
import { ConversationSettings, openConversationSettings, SettingCatalog, type SettingSpec } from "./index.ts";
import { openSettingStore } from "./records/index.ts";

let records: Records | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
});

/** A setting checked on the spot: lower case letters only, kept lower case. */
const word: SettingSpec<string> = {
  name: "test.word",
  summary: "A word",
  format: "letters, e.g. hello",
  maxChars: 10,
  check: (input) => (/^[a-z]+$/i.test(input) ? { ok: true, value: input.toLowerCase() } : { ok: false, code: "invalid_value", reason: "letters only" }),
  decode: (stored) => (/^[a-z]+$/.test(stored) ? stored : undefined),
};

/** A setting checked elsewhere, as an outside service would: "taken" is refused, "down" throws, "slow" never answers. */
const remote: SettingSpec<{ owner: string; repo: string }> = {
  name: "test.remote",
  summary: "A remote thing",
  format: "owner/repo",
  check: async (input, { signal }) => {
    await Bun.sleep(1);
    if (input === "down/x") throw new Error("connection refused");
    if (input === "slow/x") return new Promise(() => signal.addEventListener("abort", () => undefined));
    if (input === "taken/x") return { ok: false, code: "rejected", reason: "the service says no" };
    return { ok: true, value: input };
  },
  decode: (stored) => {
    const [owner, repo] = stored.split("/");
    return owner && repo ? { owner, repo } : undefined;
  },
};

async function open(specs: readonly SettingSpec<never>[] = [word, remote] as never, checkTimeoutMs = 50) {
  records = await Records.open(":memory:");
  return openConversationSettings(records, specs, { checkTimeoutMs, now: () => 5_000 });
}

test("the catalog refuses a name used twice, a name not in the format, and a limit out of range", () => {
  const spec = (name: string, maxChars?: number) => ({ ...word, name, ...(maxChars === undefined ? {} : { maxChars }) }) as SettingSpec<unknown>;
  expect(() => new SettingCatalog([spec("a.b"), spec("a.b")])).toThrow("registered twice");
  for (const bad of ["nodot", "A.b", "a..b", "a.", ".a", "a.b_c", `a.${"b".repeat(63)}`]) expect(() => new SettingCatalog([spec(bad)])).toThrow(RangeError);
  for (const bad of [0, 1001, 2.5]) expect(() => new SettingCatalog([spec("a.b", bad)])).toThrow(RangeError);
  expect(new SettingCatalog([spec("a.b", 1000), spec("gitea.repo"), spec("reply-x.format-y")]).all().length).toBe(3);
});

test("the catalog lists in the order registered, and says when it is empty", () => {
  const catalog = new SettingCatalog([remote as SettingSpec<unknown>, word as SettingSpec<unknown>]);
  expect(catalog.all().map((spec) => spec.name)).toEqual(["test.remote", "test.word"]);
  expect(catalog.get("test.word")).toBe(word as SettingSpec<unknown>);
  expect(catalog.get("test.none")).toBeUndefined();
  expect([catalog.empty, new SettingCatalog([]).empty]).toEqual([false, true]);
});

test("set keeps what the check gives back, and get decodes it", async () => {
  const settings = await open();
  const saved = await settings.set("k", " test.word ", "  HeLLo ", "ou_a");
  expect(saved).toMatchObject({ result: "saved", value: "hello" });
  expect(await settings.get("k", word)).toBe("hello");
  expect(await settings.set("k", "test.remote", "team/app", "ou_a")).toMatchObject({ result: "saved", value: "team/app" });
  expect(await settings.get("k", remote)).toEqual({ owner: "team", repo: "app" });
  expect(await settings.get("other", remote)).toBeUndefined();
});

test("set refuses an unknown name, an empty or too long value, and what the check refuses, writing nothing", async () => {
  const settings = await open();
  expect(await settings.set("k", "test.none", "x", "")).toEqual({ result: "unknown_setting" });
  expect(await settings.set("k", "test.word", "   ", "")).toMatchObject({ result: "invalid_value" });
  expect(await settings.set("k", "test.word", "a".repeat(11), "")).toMatchObject({ result: "invalid_value" });
  expect(await settings.set("k", "test.word", "a1", "")).toEqual({ result: "invalid_value", reason: "letters only" });
  expect(await settings.set("k", "test.remote", "taken/x", "")).toEqual({ result: "rejected", reason: "the service says no" });
  expect((await settings.list("k")).every((view) => view.value === undefined)).toBe(true);
});

test("a check that throws or takes too long is check_failed, and nothing is written", async () => {
  const settings = await open();
  await settings.set("k", "test.remote", "team/app", "ou_a");
  const down = await settings.set("k", "test.remote", "down/x", "ou_b");
  expect(down.result).toBe("check_failed");
  const slow = await settings.set("k", "test.remote", "slow/x", "ou_b");
  expect(slow.result).toBe("check_failed");
  expect(await settings.get("k", remote)).toEqual({ owner: "team", repo: "app" });
});

test("the check is given the conversation and a signal that aborts at the timeout", async () => {
  let seen: { key?: string; aborted?: boolean } = {};
  const watching: SettingSpec<string> = {
    ...word,
    name: "test.watch",
    check: (input, { conversationKey, signal }) =>
      new Promise((resolve) => {
        seen = { key: conversationKey };
        signal.addEventListener("abort", () => {
          seen.aborted = true;
          resolve({ ok: true, value: input });
        });
      }),
  };
  const settings = await open([watching] as never, 20);
  expect((await settings.set("feishu:oc_9", "test.watch", "x", "")).result).toBe("check_failed");
  expect(seen).toEqual({ key: "feishu:oc_9", aborted: true });
  expect(await settings.get("feishu:oc_9", watching)).toBeUndefined();
});

test("list shows every registered setting in order, set or not", async () => {
  const settings = await open();
  await settings.set("k", "test.remote", "team/app", "ou_a");
  const views = await settings.list("k");
  expect(views.map((view) => [view.spec.name, view.value, view.updatedAt])).toEqual([
    ["test.word", undefined, undefined],
    ["test.remote", "team/app", 5_000],
  ]);
});

test("a row of a setting no longer registered is kept but not seen: get is undefined, list leaves it out, and it is back when registered again", async () => {
  records = await Records.open(":memory:");
  const store = await openSettingStore(records);
  const before = new ConversationSettings(new SettingCatalog([word as SettingSpec<unknown>]), store);
  await before.set("k", "test.word", "hello", "");
  // The same table under a catalog without the setting, as after its module was taken out.
  const after = new ConversationSettings(new SettingCatalog([remote as SettingSpec<unknown>]), store);
  expect(await after.get("k", word)).toBeUndefined();
  expect((await after.list("k")).map((view) => view.spec.name)).toEqual(["test.remote"]);
  expect(await after.clear("k", "test.word")).toBe("unknown_setting");
  expect(await store.read("k", "test.word")).toBe("hello");
  const again = new ConversationSettings(new SettingCatalog([word as SettingSpec<unknown>]), store);
  expect(await again.get("k", word)).toBe("hello");
});

test("a stored value that cannot be decoded counts as not set, and is logged", async () => {
  const rows = { list: async () => [], read: async () => "NOT-A-WORD", write: async () => {}, remove: async () => "missing" as const };
  const settings = new ConversationSettings(new SettingCatalog([word as SettingSpec<unknown>]), rows);
  let value: string | undefined = "x";
  const lines = await captureLogs(async () => {
    value = await settings.get("k", word);
  });
  expect(value).toBeUndefined();
  expect(lines.filter(({ line, level }) => level === "warn" && line.includes("setting.undecodable") && line.includes("test.word")).length).toBe(1);
});

test("clear takes a setting away, idempotently; an unknown name is unknown_setting", async () => {
  const settings = await open();
  await settings.set("k", "test.word", "hello", "");
  expect(await settings.clear("k", " test.word ")).toBe("cleared");
  expect(await settings.clear("k", "test.word")).toBe("missing");
  expect(await settings.clear("k", "test.none")).toBe("unknown_setting");
  expect(await settings.get("k", word)).toBeUndefined();
});

test("a storage failure throws", async () => {
  const settings = await open();
  await records?.close();
  records = undefined;
  await expect(settings.set("k", "test.word", "hello", "")).rejects.toThrow();
  await expect(settings.list("k")).rejects.toThrow();
  await expect(settings.clear("k", "test.word")).rejects.toThrow();
});
