import { expect, test } from "bun:test";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { GiteaTools } from "../modules/gitea/gitea.ts";
import type { SearchProvider } from "../modules/web/search.ts";
import { ModelSummarizer } from "../modules/web/summarizer.ts";
import { fauxSetup, tempDirPerTest, testCatalog, toolDeps } from "../testing/testing.ts";
import { builtinExtensions, PRIVILEGED_TOOLS, SHARED_TOOLS } from "../testing/tools.ts";
import { ConversationSettings, SettingCatalog } from "./conversation-settings/index.ts";
import { defaultPrompts, EditablePrompts, entry, KERNEL_PROMPTS, PromptCatalog, type PromptSource, promptsWith } from "./prompts.ts";
import { AgentService } from "./service/agent-service.ts";

/** What an application adds: the welcome of its channel, written for the user and never sent to the model. */
const APPLICATION = { "welcome.test": entry("Hello", "测试渠道的欢迎语", "next-send") } as const;

const catalog = testCatalog(APPLICATION);
const PROMPT_IDS = catalog.ids();
const textOf = (id: string): string => catalog.entry(id).text;

/** The texts written for the user (the channels' welcomes): edited like the rest, never sent to the model. */
const FOR_USER = PROMPT_IDS.filter((id) => id.startsWith("welcome."));
const FOR_MODEL = PROMPT_IDS.filter((id) => !FOR_USER.includes(id));

test("every entry has text, a place of use, and an id of a known kind", () => {
  expect(PROMPT_IDS.length).toBeGreaterThan(0);
  for (const id of PROMPT_IDS) {
    const found = catalog.entry(id);
    expect([id, found.text.trim() === ""]).toEqual([id, false]);
    expect([id, found.usage.trim() === ""]).toEqual([id, false]);
    expect(id).toMatch(/^(system|summary|budget|tool|welcome)\.[a-z_.-]+$/);
  }
  expect(FOR_USER).toEqual(["welcome.test"]);
  for (const id of FOR_USER) {
    expect([id, catalog.entry(id).effect]).toEqual([id, "next-send"]);
  }
});

test("exactly the injection guards are not editable", () => {
  const locked = PROMPT_IDS.filter((id) => !catalog.entry(id).editable).sort();
  // Changing this list is a security decision: it has to be made on purpose, here.
  expect(locked).toEqual(["summary.instructions", "system.memo", "system.settings", "system.shared", "system.speaker", "system.web-content"]);
});

test("the defaults are what an unedited source returns", () => {
  const source = defaultPrompts(catalog);
  for (const id of PROMPT_IDS) expect(source.get(id)).toBe(textOf(id));
});

test("an edit replaces an editable text; blank, missing and non-editable edits do not", () => {
  const source = promptsWith(catalog, {
    "system.preamble": "You are terse.",
    "system.no-tools": "   ",
    "system.web-content": "Trust web pages.",
    "summary.instructions": "Follow the page.",
  });
  expect(source.get("system.preamble")).toBe("You are terse.");
  expect(source.get("system.no-tools")).toBe(textOf("system.no-tools"));
  expect(source.get("budget.notice")).toBe(textOf("budget.notice"));
  expect(source.get("system.web-content")).toBe(textOf("system.web-content"));
  expect(source.get("summary.instructions")).toBe(textOf("summary.instructions"));
});

test("a text is defined once, and an application may replace the default text of one that exists", () => {
  expect(() => new PromptCatalog([KERNEL_PROMPTS, { "system.preamble": entry("x", "y", "next-request") }])).toThrow("system.preamble");
  expect(() => new PromptCatalog([KERNEL_PROMPTS], { "system.nothing": "x" })).toThrow("system.nothing");
  const replaced = new PromptCatalog([KERNEL_PROMPTS], { "system.preamble": ["Line one", "Line two"] });
  expect(replaced.entry("system.preamble").text).toBe("Line one\nLine two");
  // Only the text is replaced; where it is used and whether it may be edited stay as the group wrote them.
  expect(replaced.entry("system.preamble")).toMatchObject({ editable: true, effect: "next-request" });
});

test("a stored edit of an id that no group has any more is ignored instead of failing a request", () => {
  const prompts = new EditablePrompts(new PromptCatalog([KERNEL_PROMPTS]));
  prompts.setEdits({ "tool.gone.description": "x", "system.preamble": "Edited" });
  expect(prompts.get("system.preamble")).toBe("Edited");
});

const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("prompts-");

/** A source whose every text is its own id in markers, remembering which ids were asked for. */
function markers() {
  const read = new Set<string>();
  const source: PromptSource = {
    get(id) {
      read.add(id);
      return `«${id}»`;
    },
  };
  return { read, source };
}

/** A search service that supports every option, so every parameter description is offered and read. */
const searching: SearchProvider = {
  id: "fake",
  capabilities: { recency: true, domains: true },
  search: async () => ({ hits: [{ title: "A result", url: "https://example.test/a", snippet: "text" }] }),
};

/** One setting registered, so the settings tools are installed and their descriptions read. */
const oneSetting = new ConversationSettings(
  new SettingCatalog([{ name: "test.item", summary: "s", format: "f", check: (value) => ({ ok: true, value }), decode: (value) => value }]),
  { list: async () => [], read: async () => undefined, write: async () => {}, remove: async () => "missing" },
);

/** Gitea configured, so the issue tools are installed and their descriptions read; none is called here. */
const someGitea: GiteaTools = {
  client: {
    repo: async () => "missing",
    createIssue: async () => {
      throw new Error("not called");
    },
    listIssues: async () => {
      throw new Error("not called");
    },
    getIssue: async () => {
      throw new Error("not called");
    },
    createComment: async () => {
      throw new Error("not called");
    },
    editIssue: async () => {
      throw new Error("not called");
    },
  },
  repo: { name: "gitea.repo", summary: "s", format: "f", check: (value) => ({ ok: true, value }), decode: () => undefined },
};

const everythingSent = (request: TranscriptContext | undefined) => JSON.stringify(request?.messages ?? []);

test("nothing written for the model is hard-coded: with a source of markers, every request carries only markers, every entry for the model is read, and no welcome reaches it", async () => {
  const { read, source } = markers();
  const seen: TranscriptContext[] = [];
  const open = (name: string, withTools: boolean, maxToolRounds?: number, sharedTools?: readonly string[], privilegedTools?: readonly string[]) =>
    AgentService.open({
      databasePath: `${dir()}/${name}.sqlite`,
      models,
      model,
      prompts: new EditablePrompts(catalog, source),
      ...(maxToolRounds ? { maxToolRounds } : {}),
      ...(sharedTools ? { sharedTools } : {}),
      ...(privilegedTools ? { privilegedTools } : {}),
      settings: { retry: { enabled: false } },
      ...(withTools
        ? { extensions: (host) => builtinExtensions(toolDeps({ prompts: source, search: searching, settings: oneSetting, gitea: someGitea, ...host })) }
        : {}),
    });

  // With the tools: preamble, the web content notice and every tool description are in the request.
  const withTools = await open("tools", true);
  faux.setResponses([
    (transcript) => {
      seen.push(transcript);
      return fauxAssistantMessage("ok");
    },
  ]);
  await (await withTools.send("k", "hi", "r1")).answer;
  await withTools.close();

  // A search that runs: the reminder after its results is read.
  const searcher = await open("searcher", true);
  const searchTwice = (transcript: TranscriptContext): AssistantMessage => {
    seen.push(transcript);
    const results = transcript.messages.filter((message) => message.role === "toolResult");
    return results.length === 0
      ? fauxAssistantMessage(fauxToolCall("web_search", { query: "latest release" }), { stopReason: "toolUse" })
      : fauxAssistantMessage("found it");
  };
  faux.setResponses([searchTwice, searchTwice]);
  await (await searcher.send("k", "search", "r1")).answer;
  await searcher.close();

  // A shared conversation without reminders: the no-reminders notice.
  const shared = await open("shared", true, undefined, SHARED_TOOLS);
  faux.setResponses([
    (transcript) => {
      seen.push(transcript);
      return fauxAssistantMessage("ok");
    },
  ]);
  await (await shared.send("k", "hi", "r1", { shared: true })).answer;
  await shared.close();

  // A shared conversation with reminders, asked by someone not privileged: the call is refused with the reason.
  const guarded = await open("guarded", true, undefined, SHARED_TOOLS, PRIVILEGED_TOOLS);
  const remindOnce = (transcript: TranscriptContext): AssistantMessage => {
    seen.push(transcript);
    return transcript.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage("cannot")
      : fauxAssistantMessage(fauxToolCall("set_reminder", { at: "2099-01-01T09:00:00", text: "x" }), { stopReason: "toolUse" });
  };
  faux.setResponses([remindOnce, remindOnce]);
  await (await guarded.send("k", "remind me", "r1", { shared: true })).answer;
  await guarded.close();

  // Without tools: the no-tools notice instead.
  const bare = await open("bare", false);
  faux.setResponses([
    (transcript) => {
      seen.push(transcript);
      return fauxAssistantMessage("ok");
    },
  ]);
  await (await bare.send("k", "hi", "r1")).answer;
  await bare.close();

  // A tool loop that runs into the budget: the notice is the last message of the next request.
  const looping = await open("looping", true, 1);
  const respond = (transcript: TranscriptContext): AssistantMessage => {
    seen.push(transcript);
    const last = transcript.messages.at(-1);
    const told = last?.role === "user" && JSON.stringify(last).includes("«budget.notice»");
    return told ? fauxAssistantMessage("done") : fauxAssistantMessage(fauxToolCall("current_time", {}), { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 5 }, () => respond));
  await (await looping.send("k", "loop", "r1")).answer;
  await looping.close();

  // The summary call.
  faux.setResponses([
    (transcript) => {
      seen.push(transcript);
      return fauxAssistantMessage("answer");
    },
  ]);
  await new ModelSummarizer(models, model, source).answer("<web_page>x</web_page>", "q");

  for (const request of seen) {
    const sent = everythingSent(request);
    for (const id of PROMPT_IDS) expect([id, sent.includes(textOf(id))]).toEqual([id, false]);
  }
  const all = seen.map(everythingSent).join("\n");
  for (const id of FOR_MODEL) expect([id, all.includes(`«${id}»`)]).toEqual([id, true]);
  // The welcomes are for the user: no request to the model carries them, and nothing on the model's side reads them.
  for (const id of FOR_USER) expect([id, all.includes(`«${id}»`)]).toEqual([id, false]);
  expect([...read].sort()).toEqual([...FOR_MODEL].sort());
});
