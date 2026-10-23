import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { captureLogs, fauxSetup, tempDirPerTest } from "../../testing/testing.ts";
import { AgentService, isEvent, type Notice, startNotices } from "../index.ts";

const { models, model } = fauxSetup();
const dir = tempDirPerTest("schedule-");

let service: AgentService | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
});

const open = async () => {
  service = await AgentService.open({ databasePath: join(dir(), "agent.sqlite"), models, model, settings: { retry: { enabled: false } } });
  return service;
};
const reopen = async () => {
  await service?.close();
  return open();
};

const GROUP = "feishu:-100123";
const all = () => true;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await condition()); i++) await sleep(10);
};
const eventsOf = async (s: AgentService) => (await s.notices(all)).filter(isEvent);

test("an event comes due as a notice of its key, with the channel's own data, and stays until confirmed, through a restart", async () => {
  let s = await open();
  const id = await s.schedule(GROUP, Date.now() + 100, { kind: "captcha_timeout", data: JSON.stringify({ user: 7 }) });
  expect(await s.notices(all)).toEqual([]);
  await until(async () => (await s.notices(all)).length > 0);
  const [notice] = await eventsOf(s);
  expect(notice).toMatchObject({ id, key: GROUP, event: { kind: "captcha_timeout", data: '{"user":7}' } });
  expect(notice?.dueAt).toBeLessThanOrEqual(Date.now());

  // Not confirmed: still there after a restart, and once confirmed it is gone for good.
  s = await reopen();
  expect((await eventsOf(s)).map((found) => found.id)).toEqual([id]);
  await s.ackNotice(id);
  s = await reopen();
  expect(await s.notices(all)).toEqual([]);
});

test("an event that came due while the process was down is delivered after the restart, and one already past fires at once", async () => {
  let s = await open();
  const down = await s.schedule(GROUP, Date.now() + 300, { kind: "k", data: "down" });
  await s.close();
  service = undefined;
  await sleep(500);
  s = await open();
  const past = await s.schedule(GROUP, Date.now() - 60_000, { kind: "k", data: "past" });
  await until(async () => (await eventsOf(s)).length === 2);
  expect((await eventsOf(s)).map((found) => [found.id, found.event.data]).sort()).toEqual(
    [
      [down, "down"],
      [past, "past"],
    ].sort(),
  );
});

test("an event withdrawn before it fires never arrives; after it fired, or for an ID that is not an event, there is nothing to withdraw", async () => {
  const s = await open();
  const waiting = await s.schedule(GROUP, Date.now() + 400, { kind: "k", data: "waiting" });
  const fired = await s.schedule(GROUP, Date.now() + 50, { kind: "k", data: "fired" });
  expect(await s.unschedule(waiting)).toBe("cancelled");
  await until(async () => (await eventsOf(s)).length > 0);
  await sleep(600);
  expect((await eventsOf(s)).map((found) => found.id)).toEqual([fired]);
  expect(await s.unschedule(fired)).toBe("gone");
  expect(await s.unschedule(waiting)).toBe("gone");
  for (const id of ["", "abc", "-1", "1.5", "99999"]) expect(await s.unschedule(id)).toBe("gone");
});

test("an event that is not usable is refused and nothing is scheduled", async () => {
  const s = await open();
  const bad = [
    { at: Date.now(), event: { kind: "", data: "" } },
    { at: Date.now(), event: { kind: "k".repeat(65), data: "" } },
    { at: Date.now(), event: { kind: "k", data: "x".repeat(2001) } },
    { at: Number.NaN, event: { kind: "k", data: "" } },
  ];
  for (const { at, event } of bad) await expect(s.schedule(GROUP, at, event)).rejects.toThrow(RangeError);
  await s.schedule(GROUP, Date.now() - 1, { kind: "k".repeat(64), data: "x".repeat(2000) });
  await until(async () => (await eventsOf(s)).length > 0);
  expect(await eventsOf(s)).toHaveLength(1);
});

test("what owns the scheduled tasks is not a chat: the console's list of conversations does not show it", async () => {
  const s = await open();
  await s.schedule(GROUP, Date.now() + 60_000, { kind: "k", data: "" });
  expect(await s.conversations()).toEqual([]);
});

const flush = async (notices: { idle(): Promise<void> }) => {
  await sleep(20);
  await notices.idle();
};

test("the channel's handler gets an event, in order with the messages, and it is confirmed only after the handler returned", async () => {
  const s = await open();
  const handled: string[] = [];
  const notices = await startNotices(s, {
    channel: "test",
    owns: all,
    send: async () => {},
    handle: async (key, event) => {
      await sleep(20);
      handled.push(`${key} ${event.kind} ${event.data}`);
    },
    retryDelaysMs: [],
  });
  await s.schedule(GROUP, Date.now() - 1, { kind: "captcha_timeout", data: "a" });
  await until(async () => handled.length > 0);
  await flush(notices);
  expect(handled).toEqual([`${GROUP} captcha_timeout a`]);
  expect(await s.notices(all)).toEqual([]);
  notices.stop();
});

test("a handler that fails is tried again; one that never succeeds leaves the event unconfirmed for the next start", async () => {
  const s = await open();
  let attempts = 0;
  const lines = await captureLogs(async () => {
    const notices = await startNotices(s, {
      channel: "test",
      owns: all,
      send: async () => {},
      handle: async () => {
        attempts++;
        if (attempts < 3) throw new Error("feishu unreachable");
      },
      retryDelaysMs: [1, 1],
      sleep,
    });
    await s.schedule(GROUP, Date.now() - 1, { kind: "k", data: "" });
    await until(async () => attempts >= 3);
    await flush(notices);
    notices.stop();
  });
  expect(attempts).toBe(3);
  expect(await s.notices(all)).toEqual([]);
  expect(lines.some(({ level }) => level === "error")).toBe(false);

  const stuck = await startNotices(s, {
    channel: "test",
    owns: all,
    send: async () => {},
    handle: async () => Promise.reject(new Error("always")),
    retryDelaysMs: [],
  });
  const lost: Notice[] = [];
  await captureLogs(async () => {
    await s.schedule(GROUP, Date.now() - 1, { kind: "k", data: "stuck" });
    await until(async () => (await eventsOf(s)).length > 0);
    await flush(stuck);
    lost.push(...(await s.notices(all)));
  });
  stuck.stop();
  expect(lost.map((notice) => isEvent(notice) && notice.event.data)).toEqual(["stuck"]);
});

test("a channel with no handler does not lose an event: it is warned about and left unconfirmed", async () => {
  const s = await open();
  const sent: string[] = [];
  const lines = await captureLogs(async () => {
    const notices = await startNotices(s, { channel: "test", owns: all, send: async (_key, text) => void sent.push(text), retryDelaysMs: [] });
    await s.schedule(GROUP, Date.now() - 1, { kind: "k", data: "" });
    await until(async () => (await eventsOf(s)).length > 0);
    await flush(notices);
    notices.stop();
  });
  expect(sent).toEqual([]);
  expect(await eventsOf(s)).toHaveLength(1);
  expect(lines.some(({ line }) => line.includes("test.notice.unhandled"))).toBe(true);
});
