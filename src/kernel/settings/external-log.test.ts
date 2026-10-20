import { afterEach, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { captureLogs, tempDirPerTest, testPrompts } from "../../testing/testing.ts";
import { AgentService } from "../service/agent-service.ts";
import type { Change, ChangeLog, ChangePage } from "./change-log.ts";
import { SettingsError } from "./error.ts";

// An application that keeps the history of changes itself (its business database) hands the service a `ChangeLog`: the
// changes are committed first and noted there after, and nothing is written to the Durable document of the history.

const faux = fauxProvider({ models: [{ id: "old" }, { id: "new" }] });
const models = createModels();
models.setProvider(faux.provider);
const OLD = { provider: "faux", modelId: "old" };
const NEW = { provider: "faux", modelId: "new" };
const dir = tempDirPerTest("external-log-");

/** A history in memory, newest last, that can be made to fail. */
class MemoryLog implements ChangeLog {
  readonly all: Change[] = [];
  failing = false;
  async record(change: Omit<Change, "seq">): Promise<void> {
    if (this.failing) throw new Error("the table is gone");
    this.all.push({ seq: this.all.length + 1, ...change });
  }
  async page(options: { limit: number; before?: number }): Promise<ChangePage> {
    const older = this.all.filter((change) => options.before === undefined || change.seq < options.before);
    const items = older.slice(-options.limit).reverse();
    const last = items.at(-1);
    return { items, ...(last !== undefined && older.length > items.length ? { next: last.seq } : {}) };
  }
}

const opened: AgentService[] = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});

async function open(changes: ChangeLog, model = OLD): Promise<AgentService> {
  const service = await AgentService.open({
    databasePath: `${dir()}/agent.sqlite`,
    models,
    model,
    prompts: testPrompts(),
    changes,
    settings: { retry: { enabled: false } },
  });
  opened.push(service);
  return service;
}

test("a prompt edit and an action on a conversation are noted in the application's log, and the console reads them from there", async () => {
  const log = new MemoryLog();
  const service = await open(log);
  await service.settings.setPrompt("system.preamble", "Persona.", 0);
  await service.settings.recordAction("chan:1", "reset");
  expect(log.all.map(({ area, target, before, after }) => [area, target, before, after])).toEqual([
    ["prompt", "system.preamble", null, "Persona."],
    ["conversation", "chan:1", null, "reset"],
  ]);
  const page = await service.settings.changes({ limit: 1 });
  expect(page.items.map((change) => change.area)).toEqual(["conversation"]);
  expect(page.next).toBe(2);
});

test("an application may note changes of its own area, but not of the kernel's", async () => {
  const log = new MemoryLog();
  const service = await open(log);
  await service.settings.record({ area: "account", target: "acc-1", before: "active", after: "disabled" });
  expect(log.all.map((change) => [change.area, change.target])).toEqual([["account", "acc-1"]]);
  for (const area of ["prompt", "allowlist", "conversation", "channel", "model", ""]) {
    expect(() => service.settings.record({ area, target: "x", before: null, after: null })).toThrow(SettingsError);
  }
  await service.settings.recordChannelChange("wechat", { target: "bot-1", before: null, after: "linked" });
  expect(log.all.at(-1)).toMatchObject({ area: "channel", target: "wechat/bot-1" });
});

test("when the application's log fails the change stands and the failure is logged", async () => {
  const log = new MemoryLog();
  const service = await open(log);
  log.failing = true;
  const lines = await captureLogs(async () => {
    const view = await service.settings.setPrompt("system.preamble", "Persona.", 0);
    expect(view).toMatchObject({ text: "Persona.", edited: true });
  });
  expect(lines.some((entry) => entry.line.includes("changes.record_failed") && entry.level === "error")).toBe(true);
  expect(log.all).toEqual([]);
});

test("conversations moved to the configured model are noted in the application's log, one entry per previous model", async () => {
  const log = new MemoryLog();
  const first = await open(log, OLD);
  faux.setResponses([() => fauxAssistantMessage("hi")]);
  await (await first.send("chan:1", "hello", "r1")).answer;
  await first.close();
  opened.pop();

  const second = await open(log, NEW);
  expect(log.all.filter((change) => change.area === "model").map(({ target, before, after }) => [target, before, after])).toEqual([
    ["1", "faux/old", "faux/new"],
  ]);
  expect((await second.settings.changes()).items.map((change) => change.area)).toEqual(["model"]);
});

test("the allowlist and the channels' documents write their history in their own commits, so they are not there", async () => {
  const service = await open(new MemoryLog());
  expect(() => service.settings.access).toThrow("not available");
  expect(() => service.settings.channel("wechat")).toThrow("not available");
});
