import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, LiveDoc } from "@earendil-works/pi-durable";
import { ConversationSettings, SettingCatalog, type SettingSpec, type SettingStore } from "../../kernel/conversation-settings/index.ts";
import { openSettingStore } from "../../kernel/conversation-settings/records/index.ts";
import { ConversationKeys } from "../../kernel/service/notices.ts";
import { Outbox } from "../../kernel/service/outbox.ts";
import { privilegedToolsHook } from "../../kernel/service/shared-tools.ts";
import { Records } from "../../platform/records/records.ts";
import { captureLogs, defaultPrompts, toolDeps } from "../../testing/testing.ts";
import { builtinTools, PRIVILEGED_TOOLS, SHARED_TOOLS } from "../../testing/tools.ts";
import { CLEAR_SETTING, createClearSettingTool, createListSettingsTool, createSetSettingTool, LIST_SETTINGS, SET_SETTING, SETTINGS_TOOLS } from "./settings.ts";

let records: Records | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
  rows = undefined;
});

/** Checked on the spot: letters, kept lower case. */
const word: SettingSpec<string> = {
  name: "test.word",
  summary: "A word for the tests",
  format: "letters, e.g. hello",
  unset: "not set: nothing is said",
  check: (input) => (/^[a-z]+$/i.test(input) ? { ok: true, value: input.toLowerCase() } : { ok: false, code: "invalid_value", reason: "letters only" }),
  decode: (stored) => stored,
};

/** Checked elsewhere: "taken/x" refused, "down/x" throws, "slow/x" never answers. */
const remote: SettingSpec<string> = {
  name: "test.remote",
  summary: "A remote thing",
  format: "owner/repo, e.g. team/app",
  check: async (input) => {
    await Bun.sleep(1);
    if (input === "down/x") throw new Error("connection refused");
    if (input === "slow/x") return new Promise(() => {});
    if (input === "taken/x") return { ok: false, code: "rejected", reason: "the service says no" };
    return { ok: true, value: input };
  },
  decode: (stored) => stored,
};

/** The rows behind the last settings opened, to see what was kept. */
let rows: SettingStore | undefined;

async function realSettings(): Promise<ConversationSettings> {
  records = await Records.open(":memory:");
  rows = await openSettingStore(records, { now: () => Date.parse("2026-10-20T01:00:00Z") });
  return new ConversationSettings(new SettingCatalog([word, remote] as SettingSpec<unknown>[]), rows, { checkTimeoutMs: 50 });
}

/** What a tool reads of the session: the channel key (none when undefined), and the run's input matched to a privileged outbox item of `asker`. */
function api(key: string | undefined, asker?: string) {
  return {
    conversationId: 7,
    snapshot: async (definition: unknown) => {
      if (definition === ConversationKeys) return key === undefined ? undefined : { key };
      if (definition === LiveDoc) return asker ? { run: { inputs: [11] } } : undefined;
      if (definition === Outbox) return { items: asker ? [{ key, requestId: "r", text: "t", speaker: { id: asker }, submission: 11, privileged: true }] : [] };
      return undefined;
    },
  } as never;
}

const tools = (settings: ConversationSettings) => {
  const deps = { settings, prompts: defaultPrompts };
  return { list: createListSettingsTool(deps), set: createSetSettingTool(deps), clear: createClearSettingTool(deps) };
};

type Result = { output?: { type: string; text?: string }[]; details?: unknown; isError?: boolean };
const codeOf = (result: Result) => (result.details as { code?: string } | undefined)?.code;
const textOf = (result: Result) => (result.output ?? []).map((part) => part.text ?? "").join("");

const run = (tool: { execute: (...args: never[]) => unknown }, args: Record<string, unknown>, on = api("feishu:oc_1", "ou_boss")) =>
  (tool.execute as (args: unknown, api: unknown, context: unknown) => Promise<Result>)(args, on, BACKGROUND_CONTEXT);

test("with no setting registered the settings tools are not installed; with one, all three, deferred and safe to replay", async () => {
  expect(builtinTools(toolDeps()).filter((tool) => (SETTINGS_TOOLS as readonly string[]).includes(tool.name))).toEqual([]);
  const installed = builtinTools(toolDeps({ settings: await realSettings() })).filter((tool) => (SETTINGS_TOOLS as readonly string[]).includes(tool.name));
  expect(installed.map((tool) => tool.name)).toEqual([...SETTINGS_TOOLS]);
  for (const tool of installed) expect([tool.name, tool.replay, tool.deferred]).toEqual([tool.name, "safe", true]);
  // Everyone may look; only the privileged may change.
  expect(SHARED_TOOLS).toContain(LIST_SETTINGS);
  expect(PRIVILEGED_TOOLS).toEqual(expect.arrayContaining([SET_SETTING, CLEAR_SETTING]));
  expect(SHARED_TOOLS).not.toContain(SET_SETTING);
});

test("list shows every setting with its summary, format and value or what not set means, and not who set it", async () => {
  const settings = await realSettings();
  const t = tools(settings);
  await run(t.set, { name: "test.remote", value: "team/app" });
  const listed = await run(t.list, {});
  expect([codeOf(listed), listed.isError]).toEqual(["listed", undefined]);
  const text = textOf(listed);
  expect(text).toContain("test.word: A word for the tests");
  expect(text).toContain("Format: letters, e.g. hello");
  expect(text).toContain("Value: not set: nothing is said");
  expect(text).toContain("Value: team/app (set 2026-10-20");
  expect(text).not.toContain("ou_boss");
  expect(text.indexOf("test.word")).toBeLessThan(text.indexOf("test.remote"));
});

test("set answers saved with the normalized value, and the writer is the asker", async () => {
  const settings = await realSettings();
  const t = tools(settings);
  let saved!: Result;
  const lines = await captureLogs(async () => {
    saved = await run(t.set, { name: " test.word ", value: " HeLLo " });
  });
  expect([codeOf(saved), saved.isError]).toEqual(["saved", undefined]);
  expect(textOf(saved)).toContain('"hello"');
  expect(await settings.get("feishu:oc_1", word)).toBe("hello");
  const line = lines.find(({ line }) => line.includes("setting.saved"))?.line ?? "";
  expect(line).toContain("ou_boss");
  expect(line).toContain("hello");
  // The writer is kept in the table.
  expect((await rows?.list("feishu:oc_1"))?.find((row) => row.name === "test.word")?.updatedBy).toBe("ou_boss");
});

test("a change is logged with the value it replaced and who asked, so the history can be read from the log", async () => {
  const settings = await realSettings();
  const t = tools(settings);
  const lines = await captureLogs(async () => {
    await run(t.set, { name: "test.word", value: "hello" });
    await run(t.set, { name: "test.word", value: "world" });
    await run(t.set, { name: "test.word", value: "a1" });
    await run(t.clear, { name: "test.word" });
  });
  const of = (event: string) => lines.filter(({ line }) => line.includes(` ${event} `)).map(({ line }) => line);
  const [first, second] = of("setting.saved");
  expect(first).not.toContain("previous=");
  expect(second).toContain("previous=hello");
  expect(second).toContain("value=world");
  expect(of("setting.rejected")[0]).toContain("by=ou_boss");
  expect(of("setting.cleared")[0]).toContain("previous=world");
  expect(of("setting.cleared")[0]).toContain("by=ou_boss");
});

test("set refuses with the codes of §5, and keeps nothing", async () => {
  const settings = await realSettings();
  const t = tools(settings);
  const cases: [Record<string, unknown>, string][] = [
    [{ name: "test.none", value: "x" }, "unknown_setting"],
    [{ name: "test.word", value: "a1" }, "invalid_value"],
    [{ name: "test.word", value: "x".repeat(201) }, "invalid_value"],
    [{ name: "test.remote", value: "taken/x" }, "rejected"],
    [{ name: "test.remote", value: "down/x" }, "check_failed"],
    [{ name: "test.remote", value: "slow/x" }, "check_failed"],
  ];
  const lines = await captureLogs(async () => {
    for (const [args, code] of cases) {
      const result = await run(t.set, args);
      expect([code, codeOf(result), result.isError]).toEqual([code, code, true]);
    }
  });
  const rejected = await run(t.set, { name: "test.remote", value: "taken/x" });
  expect(textOf(rejected)).toContain("the service says no");
  expect((await settings.list("feishu:oc_1")).every((view) => view.value === undefined)).toBe(true);
  expect(lines.filter(({ line }) => line.includes("setting.rejected")).length).toBe(3);
  expect(lines.filter(({ line, level }) => level === "warn" && line.includes("setting.check_failed")).length).toBe(2);
});

test("clear answers cleared, then missing; an unknown name is unknown_setting", async () => {
  const settings = await realSettings();
  const t = tools(settings);
  await run(t.set, { name: "test.word", value: "hello" });
  const lines = await captureLogs(async () => {
    expect(codeOf(await run(t.clear, { name: "test.word" }))).toBe("cleared");
  });
  expect(lines.some(({ line }) => line.includes("setting.cleared") && line.includes("ou_boss"))).toBe(true);
  const again = await run(t.clear, { name: "test.word" });
  expect([codeOf(again), again.isError]).toEqual(["missing", undefined]);
  const unknown = await run(t.clear, { name: "test.none" });
  expect([codeOf(unknown), unknown.isError]).toEqual(["unknown_setting", true]);
  expect(await settings.get("feishu:oc_1", word)).toBeUndefined();
});

test("each conversation has only its own settings; one without a key has none", async () => {
  const t = tools(await realSettings());
  await run(t.set, { name: "test.word", value: "one" }, api("feishu:oc_1", "ou_boss"));
  expect(textOf(await run(t.list, {}, api("feishu:oc_2")))).not.toContain("one (set");
  for (const [tool, args] of [
    [t.list, {}],
    [t.set, { name: "test.word", value: "x" }],
    [t.clear, { name: "test.word" }],
  ] as const) {
    const result = await run(tool, args, api(undefined, "ou_boss"));
    expect([codeOf(result), result.isError]).toEqual(["no_conversation", true]);
  }
});

test("storage that fails is a failure the model is told of, never a success, and is logged", async () => {
  const broken: SettingStore = {
    list: async () => Promise.reject(new Error("disk")),
    read: async () => Promise.reject(new Error("disk")),
    write: async () => Promise.reject(new Error("SQLITE_FULL")),
    remove: async () => Promise.reject(new Error("disk")),
  };
  const t = tools(new ConversationSettings(new SettingCatalog([word as SettingSpec<unknown>]), broken));
  const lines = await captureLogs(async () => {
    for (const [tool, args] of [
      [t.list, {}],
      [t.set, { name: "test.word", value: "x" }],
      [t.clear, { name: "test.word" }],
    ] as const) {
      const result = await run(tool, args);
      expect([codeOf(result), result.isError]).toEqual(["failed", true]);
    }
  });
  expect(lines.filter(({ line, level }) => level === "error" && line.includes("setting.failed")).length).toBe(3);
});

test("before the submission of a privileged input is recorded, the hook refuses set_setting; once it is, the call runs and the writer is right", async () => {
  const settings = await realSettings();
  const hook = privilegedToolsHook(PRIVILEGED_TOOLS, defaultPrompts);
  const beforeTool = (hook.handlers as { beforeTool: (call: { name: string }, api: unknown) => Promise<{ block?: string } | undefined> }).beforeTool;
  let submission: number | undefined;
  const session = {
    conversationId: 7,
    snapshot: async (definition: unknown) => {
      if (definition === AgentDoc) return { tools: [...SHARED_TOOLS, ...PRIVILEGED_TOOLS] };
      if (definition === ConversationKeys) return { key: "feishu:oc_1" };
      if (definition === LiveDoc) return { run: { inputs: [11] } };
      if (definition === Outbox)
        return {
          items: [{ key: "feishu:oc_1", requestId: "r", text: "t", speaker: { id: "ou_boss" }, privileged: true, ...(submission ? { submission } : {}) }],
        };
      return undefined;
    },
  };
  // Crashed between the submit and recording its submission: refused, and nothing written.
  expect((await beforeTool({ name: SET_SETTING }, session))?.block).toBe(defaultPrompts.get("tool.not-permitted"));
  expect((await beforeTool({ name: CLEAR_SETTING }, session))?.block).toBeDefined();
  // Everyone may look, whatever the outbox says.
  expect(await beforeTool({ name: LIST_SETTINGS }, session)).toBeUndefined();
  // The send is replayed and records it: the call runs, and the writer is the asker.
  submission = 11;
  expect(await beforeTool({ name: SET_SETTING }, session)).toBeUndefined();
  const saved = await run(tools(settings).set, { name: "test.word", value: "hello" }, session as never);
  expect(codeOf(saved)).toBe("saved");
  const lines = await captureLogs(async () => {
    await run(tools(settings).clear, { name: "test.word" }, session as never);
  });
  expect(lines.some(({ line }) => line.includes("setting.cleared") && line.includes("ou_boss"))).toBe(true);
});
