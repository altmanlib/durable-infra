import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { GITEA_ISSUE_CREATE, type GiteaTools } from "../../modules/gitea/gitea.ts";
import { GiteaHttpClient, giteaRepoSetting } from "../../modules/gitea/index.ts";
import { MEMO_TOOLS } from "../../modules/memo/memo.ts";
import { type MemoEntries, openMemoEntries } from "../../modules/memo/records/index.ts";
import { SET_REMINDER } from "../../modules/reminder/reminder.ts";
import { SETTINGS_TOOLS } from "../../modules/settings-tools/settings.ts";
import { Records } from "../../platform/records/records.ts";
import { FAKE_GITEA_TOKEN, type FakeGitea, startFakeGitea } from "../../testing/fake-gitea.ts";
import { captureLogs, defaultPrompts, fauxSetup, tempDirPerTest, toolDeps } from "../../testing/testing.ts";
import { builtinExtensions, PRIVILEGED_TOOLS, SHARED_TOOLS } from "../../testing/tools.ts";
import { ConversationSettings, openConversationSettings, SettingCatalog, type SettingSpec } from "../conversation-settings/index.ts";
import { AgentService } from "../index.ts";
import { Outbox } from "./outbox.ts";

// A group gets the shared tools; the privileged ones only for privileged runs.
const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("shared-");
let service: AgentService | undefined;
const offered: string[][] = [];
const sections: string[][] = [];
/** The text of each tool result the model was given, in order. */
const results: string[] = [];

let records: Records | undefined;
let memos: MemoEntries | undefined;
let settings: ConversationSettings | undefined;
let gitea: GiteaTools | undefined;
let fakeGitea: FakeGitea | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
  await records?.close();
  records = undefined;
  memos = undefined;
  settings = undefined;
  gitea = undefined;
  await fakeGitea?.stop();
  fakeGitea = undefined;
  offered.length = 0;
  sections.length = 0;
  results.length = 0;
});

/** The tools a request offers: declared by its system messages, a later one removing or adding some. */
function toolsOf(transcript: TranscriptContext): string[] {
  const names = new Set<string>();
  for (const message of transcript.messages) {
    if (message.role !== "system") continue;
    // A message that reorders removes every tool and adds them again: removals first.
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
  }
  return [...names];
}

type Script = (transcript: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>;
const answerOk: Script = () => fauxAssistantMessage("ok");

/** Calls `set_reminder` once, then answers. */
const remindOnce: Script = (transcript) => {
  const last = transcript.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage("done");
  return fauxAssistantMessage(fauxToolCall(SET_REMINDER, { at: "2026-10-25T09:00:00", text: "review" }), { stopReason: "toolUse" });
};

let script: Script = answerOk;

/** What a group conversation is offered with every list (web_search is not installed: no search service). */
const GROUP_TOOLS = [
  "app_status",
  "cancel_reminder",
  "current_time",
  "delete_memo",
  "get_memo",
  "list_memos",
  "list_reminders",
  "set_memo",
  "set_reminder",
  "web_fetch",
].sort();

async function open(sharedTools: readonly string[] | null = SHARED_TOOLS, privilegedTools: readonly string[] | null = PRIVILEGED_TOOLS) {
  faux.setResponses(
    Array.from({ length: 12 }, () => (transcript: TranscriptContext) => {
      offered.push(toolsOf(transcript));
      sections.push(transcript.messages.flatMap((message) => (message.role === "system" ? Object.keys(message.sections ?? {}) : [])));
      const last = transcript.messages.at(-1);
      if (last?.role === "toolResult") results.push(last.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
      return script(transcript);
    }),
  );
  service = await AgentService.open({
    databasePath: join(dir(), "agent.sqlite"),
    models,
    model,
    settings: { retry: { enabled: false } },
    ...(sharedTools ? { sharedTools } : {}),
    ...(privilegedTools ? { privilegedTools } : {}),
    extensions: (host) =>
      builtinExtensions({
        ...toolDeps({
          now: () => new Date("2026-10-19T08:00:00Z"),
          ...(memos ? { memos } : {}),
          ...(settings ? { settings } : {}),
          ...(gitea ? { gitea } : {}),
        }),
        ...host,
      }),
  });
  return service;
}

test("a shared conversation without privileged tools offers only the shared tools; others keep every tool, reminders included", async () => {
  const agents = await open(SHARED_TOOLS, null);
  await (
    await agents.send("group", "hi", "r1", { speaker: { id: "ou_a" }, shared: true })
  ).answer;
  await (
    await agents.send("private", "hi", "r2", { speaker: { id: "ou_a" } })
  ).answer;
  // web_search is not installed here (no search service), so it is left out.
  expect(offered[0]?.sort()).toEqual(["app_status", "current_time", "delete_memo", "get_memo", "list_memos", "set_memo", "web_fetch"]);
  expect(offered[1]).toEqual(expect.arrayContaining(["current_time", "set_reminder", "list_reminders", "cancel_reminder", "web_fetch"]));
  // The memo is the group's: a private conversation is not offered it.
  for (const name of MEMO_TOOLS) expect(offered[1]).not.toContain(name);
  // Told it cannot set reminders there, so it does not promise one.
  expect(sections[0]).toContain("no-reminders");
  expect(sections[1]).not.toContain("no-reminders");
});

test("a shared conversation first made by a record is restricted too, and keeps it for later questions", async () => {
  const agents = await open(SHARED_TOOLS, null);
  await agents.record("group", "earlier talk", "r1", { speaker: { id: "ou_b" }, shared: true });
  await (
    await agents.send("group", "hi", "r2", { speaker: { id: "ou_a" }, shared: true })
  ).answer;
  await (
    await agents.send("group", "again", "r3", { speaker: { id: "ou_a" } })
  ).answer;
  expect(offered.map((names) => names.includes("set_reminder"))).toEqual([false, false]);
});

test("without a shared list a shared conversation has every tool", async () => {
  const agents = await open(null, null);
  await (
    await agents.send("group", "hi", "r1", { shared: true })
  ).answer;
  expect(offered[0]).toContain("set_reminder");
});

test("a shared conversation offers the privileged tools too, and says who may use them; a private one does not get the shared notice", async () => {
  const agents = await open();
  await (
    await agents.send("group", "hi", "r1", { speaker: { id: "ou_a" }, shared: true })
  ).answer;
  await (
    await agents.send("private", "hi", "r2", { speaker: { id: "ou_a" } })
  ).answer;
  expect(offered[0]?.sort()).toEqual(GROUP_TOOLS);
  expect(sections[0]).toContain("shared");
  expect(sections[0]).not.toContain("no-reminders");
  expect(sections[1]).not.toContain("shared");
});

test("in a shared conversation a privileged asker may set a reminder; anyone else is refused with the reason", async () => {
  const agents = await open();
  script = remindOnce;
  try {
    await (
      await agents.send("group", "remind me", "r1", { speaker: { id: "ou_boss" }, shared: true, privileged: true })
    ).answer;
    await (
      await agents.send("group", "remind me too", "r2", { speaker: { id: "ou_guest" }, shared: true })
    ).answer;
  } finally {
    script = answerOk;
  }
  expect(results[0]).toContain("Reminder set");
  expect(results[1]).toContain(defaultPrompts.get("tool.not-permitted"));
  expect(results[1]).not.toContain("Reminder set");
});

test("a private conversation is not checked: every asker may set a reminder", async () => {
  const agents = await open();
  script = remindOnce;
  try {
    await (
      await agents.send("private", "remind me", "r1", { speaker: { id: "ou_guest" } })
    ).answer;
  } finally {
    script = answerOk;
  }
  expect(results[0]).toContain("Reminder set");
});

test("a shared conversation made before the privileged tools were added gets them at the next open", async () => {
  const first = await open(SHARED_TOOLS, null);
  await (
    await first.send("group", "hi", "r1", { shared: true })
  ).answer;
  await first.close();
  service = undefined;
  expect(offered[0]).not.toContain("set_reminder");

  const second = await open();
  await (
    await second.send("group", "again", "r2", { shared: true })
  ).answer;
  await (
    await second.send("private", "hi", "r3")
  ).answer;
  expect(offered[1]?.sort()).toEqual(GROUP_TOOLS);
  // The private conversation keeps every tool, the unrestricted kind, but the memo.
  expect(offered[2]).toEqual(expect.arrayContaining(["set_reminder", "web_fetch", "current_time"]));
  for (const name of MEMO_TOOLS) expect(offered[2]).not.toContain(name);
});

test("a shared conversation made before the memo gets its tools at the next open, once; a private one never does", async () => {
  const before = SHARED_TOOLS.filter((name) => !(MEMO_TOOLS as readonly string[]).includes(name));
  const first = await open(before);
  await (
    await first.send("group", "hi", "r1", { shared: true })
  ).answer;
  await (
    await first.send("private", "hi", "r2")
  ).answer;
  await first.close();
  service = undefined;
  expect(offered[0]).not.toContain("set_memo");

  let second!: AgentService;
  const moving = await captureLogs(async () => {
    second = await open();
  });
  expect(moving.filter(({ line }) => line.includes("agent.shared_tools_moved")).length).toBe(1);
  await (
    await second.send("group", "again", "r3", { shared: true })
  ).answer;
  await (
    await second.send("private", "again", "r4")
  ).answer;
  expect(offered[2]).toEqual(expect.arrayContaining([...MEMO_TOOLS]));
  for (const name of MEMO_TOOLS) expect(offered[3]).not.toContain(name);
  await second.close();
  service = undefined;

  // Already moved: the next open changes nothing.
  const again = await captureLogs(() => open());
  expect(again.filter(({ line }) => line.includes("agent.shared_tools_moved"))).toEqual([]);
});

test("anyone in a shared conversation may write the memo; the writer is kept when the outbox knows them", async () => {
  records = await Records.open(":memory:");
  memos = await openMemoEntries(records);
  const agents = await open();
  const writeOnce =
    (name: string): Script =>
    (transcript) =>
      transcript.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("noted")
        : fauxAssistantMessage(fauxToolCall("set_memo", { name, body: `# ${name}` }), { stopReason: "toolUse" });
  try {
    script = writeOnce("项目概况");
    await (
      await agents.send("group", "记一下", "r1", { speaker: { id: "ou_boss" }, shared: true, privileged: true })
    ).answer;
    script = writeOnce("买进表");
    await (
      await agents.send("group", "也记一下", "r2", { speaker: { id: "ou_guest" }, shared: true })
    ).answer;
  } finally {
    script = answerOk;
  }
  expect(results).toEqual([expect.stringContaining("Saved"), expect.stringContaining("Saved")]);
  // Every group input is matched to its outbox item, the guest's too.
  expect((await memos.get("group", "项目概况"))?.updatedBy).toBe("ou_boss");
  expect((await memos.get("group", "买进表"))?.updatedBy).toBe("ou_guest");
});

/** The outbox as stored, read after the service closed. */
async function storedOutbox() {
  const storage = await openNodeSqliteStorage(join(dir(), "agent.sqlite"));
  const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { retry: { enabled: false } } }, BACKGROUND_CONTEXT);
  try {
    return (await harness.snapshot(Outbox, BACKGROUND_CONTEXT))?.items ?? [];
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

test("every input of a group is matched to its outbox item, a private one is not: it pays no extra commit", async () => {
  const agents = await open();
  await (
    await agents.send("group", "hi", "r1", { speaker: { id: "ou_guest" }, shared: true })
  ).answer;
  await (
    await agents.send("private", "hi", "r2", { speaker: { id: "ou_a" } })
  ).answer;
  await agents.close();
  service = undefined;
  const items = await storedOutbox();
  expect(items.find((item) => item.requestId === "r1")).toMatchObject({ shared: true, submission: expect.any(Number) });
  const alone = items.find((item) => item.requestId === "r2");
  expect(alone?.submission).toBeUndefined();
  expect(alone?.shared).toBeUndefined();
});

test("an input replayed after a restart, without `shared`, is still matched: the item keeps that it was a group's", async () => {
  records = await Records.open(":memory:");
  memos = await openMemoEntries(records);
  const first = await open();
  await (
    await first.send("group", "hi", "r1", { speaker: { id: "ou_a" }, shared: true })
  ).answer;
  await first.close();
  service = undefined;

  // As if the process stopped after the item was recorded and before the input was submitted (`AgentService.send`).
  const storage = await openNodeSqliteStorage(join(dir(), "agent.sqlite"));
  const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { retry: { enabled: false } } }, BACKGROUND_CONTEXT);
  await harness.commit(async (tx) => {
    (await tx.doc(Outbox)).items.push({ key: "group", requestId: "r2", text: "记一下", speaker: { id: "ou_guest", name: "Guest" }, shared: true });
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);

  const second = await open();
  script = (transcript) =>
    transcript.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage("noted")
      : fauxAssistantMessage(fauxToolCall("set_memo", { name: "补记", body: "x" }), { stopReason: "toolUse" });
  try {
    // What replayPending does: the stored speaker, no `shared`.
    const item = (await second.pending(() => true)).find((pending) => pending.requestId === "r2");
    expect(item?.speaker).toEqual({ id: "ou_guest", name: "Guest" });
    await (
      await second.send("group", item?.text ?? "", "r2", { speaker: { id: "ou_guest", name: "Guest" } })
    ).answer;
  } finally {
    script = answerOk;
  }
  expect((await memos.get("group", "补记"))?.updatedBy).toBe("ou_guest");
});

// ---- the group's settings ----

/** A setting for the tests: letters, kept lower case. */
const word: SettingSpec<string> = {
  name: "test.word",
  summary: "A word",
  format: "letters",
  check: (input) => (/^[a-z]+$/i.test(input) ? { ok: true, value: input.toLowerCase() } : { ok: false, code: "invalid_value", reason: "letters only" }),
  decode: (stored) => stored,
};

/** Settings with `word` registered, over a real table. */
async function withSetting(): Promise<ConversationSettings> {
  records = await Records.open(":memory:");
  return openConversationSettings(records, [word as SettingSpec<unknown>]);
}

/** Settings with nothing registered, as in production until a module registers one. */
const noSettings = () =>
  new ConversationSettings(new SettingCatalog([]), {
    list: async () => [],
    read: async () => undefined,
    write: async () => {},
    remove: async () => "missing",
  });

const callOnce =
  (name: string, args: Record<string, string>): Script =>
  (transcript) =>
    transcript.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage("done")
      : fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("with a setting registered a group is offered the three settings tools and told about them; a private conversation is offered none", async () => {
  settings = await withSetting();
  const agents = await open();
  await (
    await agents.send("group", "hi", "r1", { speaker: { id: "ou_a" }, shared: true })
  ).answer;
  await (
    await agents.send("private", "hi", "r2", { speaker: { id: "ou_a" } })
  ).answer;
  expect(offered[0]?.sort()).toEqual([...GROUP_TOOLS, ...SETTINGS_TOOLS].sort());
  expect(sections[0]).toContain("settings");
  for (const name of SETTINGS_TOOLS) expect(offered[1]).not.toContain(name);
  expect(sections[1]).not.toContain("settings");
});

test("with no setting registered, as in production, nothing changes: no settings tools and no settings notice", async () => {
  settings = noSettings();
  const agents = await open();
  await (
    await agents.send("group", "hi", "r1", { speaker: { id: "ou_a" }, shared: true })
  ).answer;
  await (
    await agents.send("private", "hi", "r2", { speaker: { id: "ou_a" } })
  ).answer;
  expect(offered[0]?.sort()).toEqual(GROUP_TOOLS);
  for (const names of offered) for (const name of SETTINGS_TOOLS) expect(names).not.toContain(name);
  for (const keys of sections) expect(keys).not.toContain("settings");
});

test("in a group anyone may list the settings; only a privileged asker may set or clear one, anyone else is refused", async () => {
  settings = await withSetting();
  const agents = await open();
  let lines: { line: string }[] = [];
  try {
    lines = await captureLogs(async () => {
      script = callOnce("set_setting", { name: "test.word", value: "Hello" });
      await (
        await agents.send("group", "set it", "r1", { speaker: { id: "ou_boss" }, shared: true, privileged: true })
      ).answer;
      script = callOnce("set_setting", { name: "test.word", value: "evil" });
      await (
        await agents.send("group", "set it", "r2", { speaker: { id: "ou_guest" }, shared: true })
      ).answer;
      script = callOnce("clear_setting", { name: "test.word" });
      await (
        await agents.send("group", "clear it", "r3", { speaker: { id: "ou_guest" }, shared: true })
      ).answer;
      script = callOnce("list_settings", {});
      await (
        await agents.send("group", "show", "r4", { speaker: { id: "ou_guest" }, shared: true })
      ).answer;
    });
  } finally {
    script = answerOk;
  }
  expect(results[0]).toContain('Set test.word to "hello"');
  expect(results[1]).toContain(defaultPrompts.get("tool.not-permitted"));
  expect(results[2]).toContain(defaultPrompts.get("tool.not-permitted"));
  expect(results[3]).toContain("Value: hello");
  expect(lines.filter(({ line }) => line.includes("agent.tool_refused") && line.includes("not_privileged")).length).toBe(2);
  expect(await settings.get("group", word)).toBe("hello");
});

test("a group made with no setting registered gets the settings tools when one is, and loses them when none is again, moving once each time", async () => {
  const moves = (lines: { line: string }[]) => lines.filter(({ line }) => line.includes("agent.shared_tools_moved")).length;
  settings = noSettings();
  const first = await open();
  await (
    await first.send("group", "hi", "r1", { shared: true })
  ).answer;
  await first.close();
  service = undefined;
  expect(offered[0]?.sort()).toEqual(GROUP_TOOLS);

  settings = await withSetting();
  let second: AgentService | undefined;
  expect(
    moves(
      await captureLogs(async () => {
        second = await open();
      }),
    ),
  ).toBe(1);
  if (!second) throw new Error("not opened");
  await (
    await second.send("group", "again", "r2", { shared: true })
  ).answer;
  expect(offered[1]).toEqual(expect.arrayContaining([...SETTINGS_TOOLS]));
  await second.close();
  service = undefined;
  expect(moves(await captureLogs(async () => void (await open())))).toBe(0);
  await (service as AgentService | undefined)?.close();
  service = undefined;

  settings = noSettings();
  let third: AgentService | undefined;
  expect(
    moves(
      await captureLogs(async () => {
        third = await open();
      }),
    ),
  ).toBe(1);
  if (!third) throw new Error("not opened");
  await (
    await third.send("group", "once more", "r3", { shared: true })
  ).answer;
  expect(offered.at(-1)?.sort()).toEqual(GROUP_TOOLS);
  await third.close();
  service = undefined;
  expect(moves(await captureLogs(async () => void (await open())))).toBe(0);
});

// ---- Gitea issues ----

test("with Gitea a group is offered the issue tool and anyone may file one, signed with their name; a private conversation is not offered it", async () => {
  fakeGitea = startFakeGitea();
  fakeGitea.repos.set("team/app", { full_name: "Team/App" });
  const client = new GiteaHttpClient({ baseUrl: fakeGitea.url, token: FAKE_GITEA_TOKEN });
  gitea = { client, repo: giteaRepoSetting(client, fakeGitea.url) };
  records = await Records.open(":memory:");
  settings = await openConversationSettings(records, [gitea.repo as SettingSpec<unknown>]);
  const agents = await open();
  try {
    script = callOnce("set_setting", { name: "gitea.repo", value: "team/app" });
    await (
      await agents.send("group", "issue 记到 team/app", "r1", { speaker: { id: "ou_boss" }, shared: true, privileged: true })
    ).answer;
    script = callOnce(GITEA_ISSUE_CREATE, { title: "登录页报错", body: "背景" });
    await (
      await agents.send("group", "记个 issue", "r2", { speaker: { id: "ou_guest", name: "Guest" }, shared: true })
    ).answer;
    script = answerOk;
    await (
      await agents.send("private", "hi", "r3", { speaker: { id: "ou_a" } })
    ).answer;
  } finally {
    script = answerOk;
  }
  expect(offered[0]).toEqual(expect.arrayContaining([GITEA_ISSUE_CREATE, ...SETTINGS_TOOLS]));
  expect(offered.at(-1)).not.toContain(GITEA_ISSUE_CREATE);
  expect(results[0]).toContain("Team/App");
  expect(results[1]).toContain(`${fakeGitea.url}/Team/App/issues/1`);
  const filed = fakeGitea.seen.find((seen) => seen.method === "POST")?.body as { body: string } | undefined;
  expect(filed?.body).toContain("Guest");
});
