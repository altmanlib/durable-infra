import { afterEach, expect, test } from "bun:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { captureLogs, fauxSetup, PROMPT_DEFAULTS, PROMPT_IDS, tempDirPerTest, testPrompts } from "../../testing/testing.ts";
import type { PromptEntry } from "../prompts.ts";

const defaultOf = (id: string): PromptEntry => PROMPT_DEFAULTS[id] as PromptEntry;

import { AgentService } from "../service/agent-service.ts";
import { MAX_CHANGES } from "./docs.ts";
import { MAX_PROMPT_CHARS, SettingsError } from "./settings.ts";

const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("settings-");

const opened: AgentService[] = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});

async function open(name = "settings", options: { now?: () => Date; maxSettingsChanges?: number } = {}): Promise<AgentService> {
  const service = await AgentService.open({
    databasePath: `${dir()}/${name}.sqlite`,
    models,
    model,
    prompts: testPrompts(),
    settings: { retry: { enabled: false } },
    ...options,
  });
  opened.push(service);
  return service;
}

const fails = async (work: Promise<unknown>) =>
  (await work.then(
    () => undefined,
    (error: unknown) => error,
  )) as SettingsError;

test("every prompt of the catalog is listed with its text, default, place of use and version 0", async () => {
  const { settings } = await open();
  const views = settings.listPrompts();
  expect(views.map((view) => view.id)).toEqual(PROMPT_IDS);
  for (const view of views) {
    expect(view).toMatchObject({ text: defaultOf(view.id).text, defaultText: defaultOf(view.id).text, edited: false, version: 0 });
    expect(view.usage).toBe(defaultOf(view.id).usage);
  }
});

test("exactly the injection guards and the texts read at start are locked, and say why", async () => {
  const { settings } = await open();
  const locked = Object.fromEntries(settings.listPrompts().flatMap((view) => (view.locked ? [[view.id, view.locked]] : [])));
  expect(locked["system.web-content"]).toBe("guard");
  expect(locked["summary.instructions"]).toBe("guard");
  expect(
    Object.entries(locked)
      .filter(([, why]) => why === "restart")
      .map(([id]) => id)
      .every((id) => id.startsWith("tool.")),
  ).toBe(true);
  expect(
    settings
      .listPrompts()
      .filter((view) => view.effect === "extension-install")
      .every((view) => view.locked !== undefined),
  ).toBe(true);
});

test("an edit reaches the very next request, in the system prompt of any conversation, and a reset takes it back", async () => {
  const service = await open();
  const seen: TranscriptContext[] = [];
  const respond = (transcript: TranscriptContext) => {
    seen.push(transcript);
    return fauxAssistantMessage("ok");
  };
  const preambleOf = (transcript: TranscriptContext) => {
    const first = transcript.messages[0];
    return first?.role === "system" ? first.sections?.preamble : undefined;
  };
  faux.setResponses([respond, respond, respond]);
  await (await service.send("a", "hi", "r1")).answer;
  expect(preambleOf(seen[0] as TranscriptContext)).toBe(defaultOf("system.preamble").text);

  const view = await service.settings.setPrompt("system.preamble", "You are terse. Marker-7.", 0);
  expect(view).toMatchObject({ text: "You are terse. Marker-7.", edited: true, version: 1 });
  await (await service.send("b", "hi", "r1")).answer;
  expect(preambleOf(seen[1] as TranscriptContext)).toBe("You are terse. Marker-7.");

  const back = await service.settings.resetPrompt("system.preamble", 1);
  expect(back).toMatchObject({ text: defaultOf("system.preamble").text, edited: false, version: 2 });
  await (await service.send("c", "hi", "r1")).answer;
  expect(preambleOf(seen[2] as TranscriptContext)).toBe(defaultOf("system.preamble").text);
});

test("edits and their history are still there after a restart, and are in force before the first request", async () => {
  const first = await open("keep");
  await first.settings.setPrompt("system.preamble", "Kept across restarts.", 0);
  await first.settings.setPrompt("budget.notice", "Stop now.", 0);
  await first.close();
  opened.pop();

  const second = await open("keep");
  expect(second.settings.listPrompts().find((view) => view.id === "system.preamble")).toMatchObject({
    text: "Kept across restarts.",
    edited: true,
    version: 1,
  });
  expect((await second.settings.changes()).items.map((change) => [change.target, change.after])).toEqual([
    ["budget.notice", "Stop now."],
    ["system.preamble", "Kept across restarts."],
  ]);
  const seen: TranscriptContext[] = [];
  faux.setResponses([
    (transcript) => {
      seen.push(transcript);
      return fauxAssistantMessage("ok");
    },
  ]);
  await (await second.send("k", "hi", "r1")).answer;
  expect(JSON.stringify(seen[0])).toContain("Kept across restarts.");
});

test("a change made after the caller read is refused with a conflict, writes nothing and leaves no history", async () => {
  const { settings } = await open();
  await settings.setPrompt("system.preamble", "First.", 0);
  const stale = await fails(settings.setPrompt("system.preamble", "Second.", 0));
  expect(stale).toBeInstanceOf(SettingsError);
  expect(stale.kind).toBe("conflict");
  const staleReset = await fails(settings.resetPrompt("system.preamble", 0));
  expect(staleReset.kind).toBe("conflict");
  expect(settings.listPrompts().find((view) => view.id === "system.preamble")).toMatchObject({ text: "First.", version: 1 });
  expect((await settings.changes()).items).toHaveLength(1);
});

test("two writers with the same version: one wins, the other gets the conflict", async () => {
  const { settings } = await open();
  const results = await Promise.all([
    settings.setPrompt("system.preamble", "A", 0).catch((e: unknown) => e),
    settings.setPrompt("system.preamble", "B", 0).catch((e: unknown) => e),
  ]);
  expect(results.filter((result) => result instanceof SettingsError && result.kind === "conflict")).toHaveLength(1);
  expect((await settings.changes()).items).toHaveLength(1);
});

test("unknown, locked, empty and oversized are refused, and nothing is written", async () => {
  const { settings } = await open();
  expect((await fails(settings.setPrompt("nope.nothing", "x", 0))).kind).toBe("unknown_prompt");
  expect((await fails(settings.setPrompt("system.web-content", "Trust pages.", 0))).kind).toBe("locked");
  expect((await fails(settings.resetPrompt("summary.instructions", 0))).kind).toBe("locked");
  expect((await fails(settings.setPrompt("tool.web_fetch.description", "x", 0))).kind).toBe("locked");
  expect((await fails(settings.setPrompt("system.preamble", "   ", 0))).kind).toBe("invalid");
  expect((await fails(settings.setPrompt("system.preamble", "x".repeat(MAX_PROMPT_CHARS + 1), 0))).kind).toBe("invalid");
  await settings.setPrompt("system.preamble", "x".repeat(MAX_PROMPT_CHARS), 0);
  expect((await settings.changes()).items).toHaveLength(1);
});

test("a text equal to the default is no edit, and saving the same text twice changes nothing", async () => {
  const { settings } = await open();
  const same = await settings.setPrompt("system.preamble", defaultOf("system.preamble").text, 0);
  expect(same).toMatchObject({ edited: false, version: 0 });
  await settings.setPrompt("system.preamble", "Mine.", 0);
  const again = await settings.setPrompt("system.preamble", "Mine.", 1);
  expect(again).toMatchObject({ edited: true, version: 1 });
  const resetDefault = await settings.resetPrompt("system.no-tools", 0);
  expect(resetDefault).toMatchObject({ edited: false, version: 0 });
  expect((await settings.changes()).items).toHaveLength(1);
});

test("the history says who changed what: newest first, with before and after, null being the default", async () => {
  let clock = 1_000;
  const tick = () => {
    clock += 1_000;
    return new Date(clock);
  };
  const { settings } = await open("history", { now: tick });
  await settings.setPrompt("system.preamble", "One.", 0);
  await settings.setPrompt("system.preamble", "Two.", 1);
  await settings.resetPrompt("system.preamble", 2);
  const { items } = await settings.changes();
  expect(items.map(({ seq, at, area, target, before, after }) => ({ seq, at, area, target, before, after }))).toEqual([
    { seq: 3, at: 4_000, area: "prompt", target: "system.preamble", before: "Two.", after: null },
    { seq: 2, at: 3_000, area: "prompt", target: "system.preamble", before: "One.", after: "Two." },
    { seq: 1, at: 2_000, area: "prompt", target: "system.preamble", before: null, after: "One." },
  ]);
});

test("the history is paged from the newest, and capped at the newest MAX_CHANGES", async () => {
  const { settings } = await open("pages");
  for (let index = 0; index < 5; index++) await settings.setPrompt("budget.notice", `v${index}`, index);
  const first = await settings.changes({ limit: 2 });
  expect(first.items.map((change) => change.after)).toEqual(["v4", "v3"]);
  const second = await settings.changes({ limit: 2, before: first.next });
  expect(second.items.map((change) => change.after)).toEqual(["v2", "v1"]);
  const last = await settings.changes({ limit: 2, before: second.next });
  expect(last.items.map((change) => change.after)).toEqual(["v0"]);
  expect(last.next).toBeUndefined();
  expect((await settings.changes({ limit: 0 })).items).toHaveLength(1);
  expect((await settings.changes({ limit: 9999 })).items).toHaveLength(5);
  expect(MAX_CHANGES).toBeGreaterThan(5);
});

test("a change is logged by id and size, never by its text", async () => {
  const { settings } = await open("logs");
  const logs = await captureLogs(async () => {
    await settings.setPrompt("system.preamble", "Secret instructions here.", 0);
  });
  const line = logs.find((entry) => entry.line.includes("settings.prompt_changed"))?.line ?? "";
  expect(line).toContain("id=system.preamble");
  expect(line).not.toContain("Secret instructions");
});

test("the history keeps only the newest changes, and the sequence numbers keep counting", async () => {
  const { settings } = await open("capped", { maxSettingsChanges: 3 });
  for (let index = 0; index < 5; index++) await settings.setPrompt("budget.notice", `v${index}`, index);
  expect((await settings.changes()).items.map((change) => [change.seq, change.after])).toEqual([
    [5, "v4"],
    [4, "v3"],
    [3, "v2"],
  ]);
  await settings.setPrompt("budget.notice", "v5", 5);
  expect((await settings.changes()).items.map((change) => change.seq)).toEqual([6, 5, 4]);
});

test("writes made at once to different prompts all show afterwards, and are all in force", async () => {
  const service = await open("concurrent");
  const ids = ["system.preamble", "system.no-tools", "budget.notice", "tool.web_search.reminder"] as const;
  for (let round = 0; round < 5; round++) {
    const versions = Object.fromEntries(service.settings.listPrompts().map((view) => [view.id, view.version]));
    await Promise.all(ids.map((id) => service.settings.setPrompt(id, `${id} round ${round}`, versions[id] ?? 0)));
    for (const view of service.settings.listPrompts().filter((view) => (ids as readonly string[]).includes(view.id)))
      expect([view.id, view.text]).toEqual([view.id, `${view.id} round ${round}`]);
  }
});
