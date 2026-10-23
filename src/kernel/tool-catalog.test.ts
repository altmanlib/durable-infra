import { afterEach, expect, test } from "bun:test";

import { clockModule } from "../modules/clock/index.ts";
import { giteaModule } from "../modules/gitea/index.ts";
import { memoModule } from "../modules/memo/index.ts";
import { reminderModule } from "../modules/reminder/index.ts";
import { settingsToolsModule } from "../modules/settings-tools/index.ts";
import { webModule } from "../modules/web/index.ts";
import { Records } from "../platform/records/records.ts";
import { fauxSetup, testPrompts, toolDeps } from "../testing/testing.ts";
import { openConversationSettings, type SettingSpec } from "./conversation-settings/index.ts";
import type { Module, ToolSpec } from "./module.ts";
import { describeTools, formatToolCatalog, sharedToolNames } from "./tool-catalog.ts";

const { models, model } = fauxSetup();

let records: Records | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
});

// Gitea is listed to give the settings tools a setting to configure; it makes no request here.
const gitea = () => giteaModule({ url: "http://127.0.0.1:9", token: "unused" });
const everything = (web = webModule({ tavilyApiKey: "unused" })): Module[] => [
  clockModule(),
  reminderModule(),
  web,
  memoModule(),
  settingsToolsModule(),
  gitea(),
];

const rowOf = (modules: readonly Module[], name: string) => describeTools(modules).tools.find((row) => row.name === name);

test("a tool is offered to one person and to a group by what its module declared, not by its name", () => {
  const modules = everything();
  expect(rowOf(modules, "current_time")).toMatchObject({ module: "clock", private: true, group: "anyone", off: false });
  expect(rowOf(modules, "set_reminder")).toMatchObject({ private: true, group: "privileged" });
  expect(rowOf(modules, "list_memos")).toMatchObject({ private: false, group: "anyone" });
  expect(rowOf(modules, "set_setting")).toMatchObject({ private: false, group: "privileged" });
});

test("the catalog follows the order the application listed its modules", () => {
  expect(describeTools(everything()).modules).toEqual(["clock", "reminder", "web", "memo", "settings-tools", "gitea"]);
  expect(describeTools([reminderModule(), clockModule()]).tools.map((row) => row.module)).toEqual(["reminder", "reminder", "reminder", "clock", "clock"]);
});

test("a tool that the configuration leaves out is listed as off, and a shared conversation is not given its name", () => {
  const without = everything(webModule());
  expect(rowOf(without, "web_search")).toMatchObject({ off: true, private: false, group: "none" });
  expect(rowOf(without, "web_search")?.note).toBeString();
  expect(sharedToolNames(without).shared).not.toContain("web_search");
  const searching = everything();
  expect(rowOf(searching, "web_search")).toMatchObject({ off: false, private: true, group: "anyone" });
  expect(sharedToolNames(searching).shared).toContain("web_search");
});

test("a shared conversation is given every tool the modules declare, split by who may call it", () => {
  const { shared, privileged } = sharedToolNames(everything());
  expect(privileged.sort()).toEqual(["cancel_reminder", "clear_setting", "list_reminders", "set_reminder", "set_setting"]);
  expect(shared).toContain("current_time");
  expect(shared).toContain("set_memo");
  expect(shared.filter((name) => privileged.includes(name))).toEqual([]);
});

test("a module without declarations offers nothing", () => {
  const bare: Module = { name: "bare", contribute: () => ({}) };
  expect(describeTools([bare])).toEqual({ modules: ["bare"], tools: [] });
  expect(sharedToolNames([bare])).toEqual({ shared: [], privileged: [] });
});

test("the table has a line for every tool, and says when there is none", () => {
  const catalog = describeTools(everything());
  const lines = formatToolCatalog(catalog).split("\n");
  for (const row of catalog.tools) expect(lines.some((line) => line.startsWith(`${row.name} `))).toBe(true);
  expect(formatToolCatalog(describeTools([]))).toContain("No tools");
});

test("as JSON the catalog comes back whole, for a program to read", () => {
  const catalog = describeTools(everything());
  expect(JSON.parse(formatToolCatalog(catalog, { json: true }))).toEqual(JSON.parse(JSON.stringify(catalog)));
});

/** The tools each module contributes, built as `openCore` builds them, without a service. */
async function contributed(modules: readonly Module[]) {
  records = await Records.open(":memory:");
  const prompts = testPrompts();
  const specs: SettingSpec<unknown>[] = [];
  for (const module of modules) specs.push(...((await module.prepare?.({ records, prompts, models, model })) ?? []));
  const settings = await openConversationSettings(records, specs);
  return modules.flatMap((module) => (module.contribute({ ...toolDeps(), prompts, settings }).tools ?? []).map((tool) => ({ module, tool })));
}

// Where a tool is offered is said twice, in its module's declaration and in the tool's own `deferred`: this holds the two together.
for (const [label, web] of [
  ["with a search service", webModule({ tavilyApiKey: "unused" })],
  ["without a search service", webModule()],
] as const) {
  test(`what the modules declare is what they contribute, ${label}`, async () => {
    const modules = everything(web);
    const made = await contributed(modules);
    const declared = new Map<string, ToolSpec>(
      modules.flatMap((module) => (module.toolSpecs ?? []).filter((spec) => !spec.off).map((spec) => [spec.name, spec] as const)),
    );
    expect(made.map(({ tool }) => tool.name).sort()).toEqual([...declared.keys()].sort());
    for (const { tool } of made) expect([tool.name, tool.deferred === true]).toEqual([tool.name, declared.get(tool.name)?.scope === "shared-only"]);
  });
}

test("every declared tool has its description among its module's texts", () => {
  const missing = everything().flatMap((module) =>
    (module.toolSpecs ?? []).filter((spec) => !module.prompts?.[`tool.${spec.name}.description`]).map((spec) => spec.name),
  );
  expect(missing).toEqual([]);
});
