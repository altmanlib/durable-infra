import { afterEach, expect, test } from "bun:test";
import { captureLogs, fauxSetup, tempDirPerTest } from "../../testing/testing.ts";
import { AgentService } from "../service/agent-service.ts";
import { MAX_DENIED } from "./access.ts";
import { SettingsError } from "./error.ts";

const { models, model } = fauxSetup();
const dir = tempDirPerTest("access-");

const opened: AgentService[] = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});

async function open(name = "access", options: { now?: () => Date } = {}): Promise<AgentService> {
  const service = await AgentService.open({ databasePath: `${dir()}/${name}.sqlite`, models, model, settings: { retry: { enabled: false } }, ...options });
  opened.push(service);
  return service;
}

const fails = async (work: Promise<unknown>) =>
  (await work.then(
    () => undefined,
    (error: unknown) => error,
  )) as SettingsError;

test("the first start stores the configured users as the list, and says so in the history", async () => {
  const { settings } = await open();
  const access = await settings.access.open("feishu", [2002, 1001]);
  expect(access.allows(1001)).toBe(true);
  expect(access.allows("2002")).toBe(true);
  expect(access.allows(3003)).toBe(false);
  expect(settings.access.list().channels).toEqual([{ channel: "feishu", userIds: ["1001", "2002"], version: 1 }]);
  expect(settings.changes().items.map(({ area, target, before, after }) => ({ area, target, before, after }))).toEqual([
    { area: "allowlist", target: "feishu", before: null, after: "1001,2002" },
  ]);
});

test("a list that is not configured the way a channel can use is refused: empty, or an ID that is not one", async () => {
  const { settings } = await open();
  await expect(settings.access.open("feishu", [])).rejects.toThrow("non-empty");
  await expect(settings.access.open("feishu", ["12 34"])).rejects.toThrow("valid user IDs");
  expect(settings.access.list().channels).toEqual([]);
});

test("after the first start the stored list rules, the console's changes survive a restart, and a different configured list is only noted", async () => {
  const first = await open("keep");
  const access = await first.settings.access.open("feishu", [1001]);
  const view = first.settings.access.list().channels[0];
  await first.settings.access.set("feishu", ["1001", "4004"], view?.version ?? 0);
  expect(access.allows(4004)).toBe(true);
  await first.close();
  opened.pop();

  const second = await open("keep");
  let reopened: Awaited<ReturnType<typeof second.settings.access.open>> | undefined;
  const logs = await captureLogs(async () => {
    reopened = await second.settings.access.open("feishu", [9999]);
  });
  expect(reopened?.allows(4004)).toBe(true);
  expect(reopened?.allows(1001)).toBe(true);
  expect(reopened?.allows(9999)).toBe(false);
  expect(logs.some((entry) => entry.level === "warn" && entry.line.includes("access.env_ignored") && entry.line.includes("channel=feishu"))).toBe(true);
  expect(second.settings.access.list().channels[0]).toMatchObject({ userIds: ["1001", "4004"], version: 2 });

  // The same list as stored says nothing.
  await second.close();
  opened.pop();
  const third = await open("keep");
  const quiet = await captureLogs(async () => {
    await third.settings.access.open("feishu", [4004, 1001]);
  });
  expect(quiet.filter((entry) => entry.level === "warn")).toEqual([]);
});

test("a change takes effect for the very next message, and is in the history next to the prompts'", async () => {
  const { settings } = await open();
  const access = await settings.access.open("feishu", [1001]);
  await settings.setPrompt("system.preamble", "Terse.", 0);
  const saved = await settings.access.set("feishu", [" 2002 ", "1001", "2002"], 1);
  expect(saved).toEqual({ channel: "feishu", userIds: ["1001", "2002"], version: 2 });
  expect(access.allows(2002)).toBe(true);
  await settings.access.set("feishu", ["2002"], 2);
  expect(access.allows(1001)).toBe(false);
  expect(settings.changes().items.map(({ area, target, before, after }) => [area, target, before, after])).toEqual([
    ["allowlist", "feishu", "1001,2002", "2002"],
    ["allowlist", "feishu", "1001", "1001,2002"],
    ["prompt", "system.preamble", null, "Terse."],
    ["allowlist", "feishu", null, "1001"],
  ]);
});

test("the list never goes empty, takes only valid IDs, knows only channels that started, and refuses a stale version", async () => {
  const { settings } = await open();
  await settings.access.open("feishu", [1001]);
  expect((await fails(settings.access.set("feishu", [], 1))).kind).toBe("allowlist_empty");
  expect((await fails(settings.access.set("feishu", ["  "], 1))).kind).toBe("invalid_user_id");
  expect((await fails(settings.access.set("feishu", ["ok", "no good"], 1))).kind).toBe("invalid_user_id");
  expect((await fails(settings.access.set("feishu", ["x".repeat(65)], 1))).kind).toBe("invalid_user_id");
  expect((await fails(settings.access.set("discord", ["1"], 0))).kind).toBe("unknown_channel");
  await settings.access.set("feishu", ["1001", "2002"], 1);
  expect((await fails(settings.access.set("feishu", ["3003"], 1))).kind).toBe("conflict");
  expect(settings.access.list().channels[0]).toMatchObject({ userIds: ["1001", "2002"], version: 2 });
  expect(settings.changes().items).toHaveLength(2);
});

test("saving the same list again changes nothing and leaves no history", async () => {
  const { settings } = await open();
  await settings.access.open("feishu", [1001, 2002]);
  const same = await settings.access.set("feishu", ["2002", "1001"], 1);
  expect(same.version).toBe(1);
  expect(settings.changes().items).toHaveLength(1);
});

test("two writers with the same version: one wins, the other gets the conflict", async () => {
  const { settings } = await open();
  await settings.access.open("feishu", [1001]);
  const results = await Promise.all([
    settings.access.set("feishu", ["1001", "2"], 1).catch((e: unknown) => e),
    settings.access.set("feishu", ["1001", "3"], 1).catch((e: unknown) => e),
  ]);
  expect(results.filter((result) => result instanceof SettingsError && result.kind === "conflict")).toHaveLength(1);
  expect(settings.access.list().channels[0]?.version).toBe(2);
});

test("people turned away are listed, newest first, with how often; those let in since are dropped; only memory remembers them", async () => {
  let clock = 10_000;
  const tick = () => {
    clock += 1_000;
    return new Date(clock);
  };
  const { settings } = await open("denied", { now: tick });
  const access = await settings.access.open("feishu", [1001]);
  access.denied(2002);
  access.denied(3003);
  access.denied(2002);
  access.denied(1001);
  expect(settings.access.list().denied.map(({ userId, count }) => [userId, count])).toEqual([
    ["2002", 2],
    ["3003", 1],
  ]);
  await settings.access.set("feishu", ["1001", "2002"], 1);
  expect(settings.access.list().denied.map((user) => user.userId)).toEqual(["3003"]);
  // Someone already let in who is reported anyway (a message still in flight) is not remembered as turned away.
  await settings.access.set("feishu", ["1001", "2002", "4004"], 2);
  access.denied(4004);
  await settings.access.set("feishu", ["1001", "2002"], 3);
  expect(settings.access.list().denied.map((user) => user.userId)).toEqual(["3003"]);
});

test("only the most recent MAX_DENIED people are remembered", async () => {
  let clock = 0;
  const tick = () => {
    clock += 1;
    return new Date(clock);
  };
  const { settings } = await open("many", { now: tick });
  const access = await settings.access.open("feishu", [1]);
  for (let id = 100; id < 100 + MAX_DENIED + 10; id++) access.denied(id);
  const denied = settings.access.list().denied;
  expect(denied).toHaveLength(MAX_DENIED);
  expect(denied[0]?.userId).toBe(String(100 + MAX_DENIED + 9));
  expect(denied.some((user) => user.userId === "100")).toBe(false);
});

test("turned-away people are not stored: after a restart the list is empty", async () => {
  const first = await open("forget");
  (await first.settings.access.open("feishu", [1])).denied(2002);
  expect(first.settings.access.list().denied).toHaveLength(1);
  await first.close();
  opened.pop();
  const second = await open("forget");
  await second.settings.access.open("feishu", [1]);
  expect(second.settings.access.list().denied).toEqual([]);
});
