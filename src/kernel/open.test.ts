import { afterEach, expect, test } from "bun:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { clockModule } from "../modules/clock/index.ts";
import { giteaModule } from "../modules/gitea/index.ts";
import { memoModule } from "../modules/memo/index.ts";
import { reminderModule } from "../modules/reminder/index.ts";
import { settingsToolsModule } from "../modules/settings-tools/index.ts";
import { webModule } from "../modules/web/index.ts";
import { fauxSetup, tempDirPerTest } from "../testing/testing.ts";
import { loadCoreConfig } from "./config.ts";
import type { Module } from "./module.ts";
import { type Core, type OpenCoreOptions, openCore } from "./open.ts";
import { entry } from "./prompts.ts";

const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("open-");
let core: Core | undefined;

afterEach(async () => {
  await core?.close();
  core = undefined;
});

const env = { LLM_BASE_URL: "http://localhost/v1", LLM_API_KEY: "key" };

/** The core on a fresh directory with the scripted model; `modules` is what the application chose. */
function open(modules: readonly Module[], extra: Partial<OpenCoreOptions> = {}) {
  return openCore({
    config: loadCoreConfig(dir(), env),
    version: "1.2.3",
    logDir: `${dir()}/logs`,
    modules,
    llm: { models, model },
    service: { settings: { retry: { enabled: false } } },
    ...extra,
  });
}

/** The tools a request announced; a transcript carries them on its system entries. */
const offeredTools = (request: TranscriptContext | undefined): string[] =>
  (request?.messages ?? []).flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []));

/** Ask once in `key` and return the tools the request offered. */
async function toolsFor(opened: Core, key: string, options: { shared?: boolean } = {}): Promise<string[]> {
  let seen: TranscriptContext | undefined;
  faux.setResponses([
    (transcript) => {
      seen = transcript;
      return fauxAssistantMessage("ok");
    },
  ]);
  await (await opened.agent.send(key, "hi", "r1", options)).answer;
  return offeredTools(seen);
}

// A gitea module is listed to give the settings tools something to configure; it makes no request here.
const gitea = () => giteaModule({ url: "http://127.0.0.1:9", token: "unused" });
const everything = () => [clockModule(), reminderModule(), webModule(), memoModule(), settingsToolsModule(), gitea()];

test("the modules an application lists are the tools its conversations have; the ones it leaves out are not there", async () => {
  core = await open([clockModule(), reminderModule()]);
  const tools = await toolsFor(core, "private");
  expect(tools.sort()).toEqual(["app_status", "cancel_reminder", "current_time", "list_reminders", "set_reminder"]);
});

test("with no module the conversation has no tools, and the service says so", async () => {
  core = await open([]);
  expect(await toolsFor(core, "private")).toEqual([]);
});

test("a shared conversation has the modules' shared tools and the privileged ones, and nothing a module did not declare", async () => {
  core = await open(everything());
  const tools = await toolsFor(core, "group", { shared: true });
  expect(tools.sort()).toEqual(
    [
      "app_status",
      "cancel_reminder",
      "clear_setting",
      "current_time",
      "delete_memo",
      "get_memo",
      "gitea_create_issue",
      "list_memos",
      "list_reminders",
      "list_settings",
      "set_memo",
      "set_reminder",
      "set_setting",
      "web_fetch",
    ].sort(),
  );
});

test("a private conversation keeps every tool but the ones deferred to shared conversations", async () => {
  core = await open(everything());
  const tools = await toolsFor(core, "private");
  expect(tools).toContain("web_fetch");
  expect(tools).toContain("set_reminder");
  expect(tools).not.toContain("set_memo");
  expect(tools).not.toContain("list_settings");
});

test("a module's own table and settings are opened before the first request, in the same database as the channels'", async () => {
  core = await open(everything());
  expect(core.settings).toBeDefined();
  expect(await core.records.health()).toEqual({ ok: true });
});

test("the texts of the modules and of the application are one catalog the console edits; the application replaces a default text", async () => {
  core = await open([clockModule(), memoModule()], {
    prompts: {
      entries: { "welcome.test": entry("Hello", "测试渠道的欢迎语", "next-send") },
      replace: { "system.preamble": "You are the test persona." },
    },
  });
  const ids = core.settings.listPrompts().map((view) => view.id);
  expect(ids).toContain("welcome.test");
  expect(ids).toContain("tool.current_time.description");
  expect(ids).toContain("tool.set_memo.description");
  // A module that is not opened brings none of its texts.
  expect(ids).not.toContain("tool.set_reminder.description");
  expect(core.prompts.get("welcome.test")).toBe("Hello");
  expect(core.prompts.get("system.preamble")).toBe("You are the test persona.");
  const view = await core.settings.setPrompt("welcome.test", "Hi there", 0);
  expect(view).toMatchObject({ text: "Hi there", edited: true });
  expect(core.prompts.get("welcome.test")).toBe("Hi there");
});

test("two modules that define the same text do not open together", async () => {
  const twice: Module = { name: "twice", prompts: { "tool.current_time.description": entry("x", "y", "extension-install") }, contribute: () => ({}) };
  await expect(open([clockModule(), twice])).rejects.toThrow("tool.current_time.description");
});

test("a module that fails to prepare leaves nothing open", async () => {
  const broken: Module = {
    name: "broken",
    prepare: async () => {
      throw new Error("no table");
    },
    contribute: () => ({}),
  };
  await expect(open([broken])).rejects.toThrow("no table");
  // The records were closed: the same files open again.
  core = await open([clockModule()]);
  expect(await core.records.health()).toEqual({ ok: true });
});

test("the application version and start time reach the modules", async () => {
  core = await open([clockModule()], { now: () => new Date("2026-10-20T01:00:00Z") });
  let answer = "";
  faux.setResponses([
    () => fauxAssistantMessage([{ type: "toolCall", id: "t1", name: "app_status", arguments: {} }], { stopReason: "toolUse" }),
    (transcript) => {
      const result = transcript.messages.findLast((message) => message.role === "toolResult");
      answer = result?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
      return fauxAssistantMessage("done");
    },
  ]);
  await (await core.agent.send("k", "status", "r1")).answer;
  expect(answer).toContain("1.2.3");
});
