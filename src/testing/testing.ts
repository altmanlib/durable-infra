// Shared setup for tests. Not imported by production code, so it never reaches the bundle.
import { afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GenerationTask, hook } from "@earendil-works/pi-durable";
import { ConversationSettings, SettingCatalog } from "../kernel/conversation-settings/index.ts";
import type { BaseDeps } from "../kernel/module.ts";
import {
  defaultPrompts as defaultPromptsOf,
  EditablePrompts,
  KERNEL_PROMPTS,
  PromptCatalog,
  type PromptEntries,
  type PromptEntry,
  type PromptSource,
} from "../kernel/prompts.ts";
import type { AgentExtension } from "../kernel/service/host.ts";
import { messageText, splitSpeaker } from "../kernel/service/transcript.ts";
import type { Change, ChangeLog, ChangePage } from "../kernel/settings/change-log.ts";
import { CLOCK_PROMPTS } from "../modules/clock/prompts.ts";
import type { GiteaTools } from "../modules/gitea/gitea.ts";
import { GITEA_PROMPTS } from "../modules/gitea/prompts.ts";
import { MEMO_PROMPTS } from "../modules/memo/prompts.ts";
import type { MemoStore } from "../modules/memo/records/index.ts";
import { REMINDER_PROMPTS } from "../modules/reminder/prompts.ts";
import { SETTINGS_TOOLS_PROMPTS } from "../modules/settings-tools/prompts.ts";
import type { PageFetcher } from "../modules/web/fetcher.ts";
import { WEB_PROMPTS } from "../modules/web/prompts.ts";
import type { SearchProvider } from "../modules/web/search.ts";
import type { PageSummarizer } from "../modules/web/summarizer.ts";
import { type LogLevel, setLogSink } from "../platform/log.ts";

/** All texts: the kernel's, the modules', and the application's `extra`. */
export const testCatalog = (extra: PromptEntries = {}): PromptCatalog =>
  new PromptCatalog([KERNEL_PROMPTS, CLOCK_PROMPTS, REMINDER_PROMPTS, WEB_PROMPTS, MEMO_PROMPTS, SETTINGS_TOOLS_PROMPTS, GITEA_PROMPTS, extra]);

/** The texts in force with no edit, for tests that read or render them. */
export const testPrompts = (): EditablePrompts => new EditablePrompts(testCatalog());

/** The built-in texts of that catalog, for the tests that compare against them. */
const allPrompts = testCatalog();
export const PROMPT_IDS: string[] = allPrompts.ids();
export const PROMPT_DEFAULTS: Readonly<Record<string, PromptEntry>> = Object.fromEntries(PROMPT_IDS.map((id) => [id, allPrompts.entry(id)]));
export const defaultPrompts: PromptSource = defaultPromptsOf(allPrompts);

/** The text of the last user message in a request, without the speaker tag the service puts in front of it. */
export function lastUserText(transcript: TranscriptContext): string {
  const user = transcript.messages.findLast((message) => message.role === "user");
  return splitSpeaker(user)?.text ?? messageText(user) ?? "";
}

export type FauxOptions = { id?: string; contextWindow?: number; maxTokens?: number; tokensPerSecond?: number };

/** A scripted model: queue answers with `faux.setResponses`, and open services on `models` with `model`. */
export function fauxSetup(options: FauxOptions = {}) {
  const { id = "test", contextWindow = 100_000, maxTokens = 1000, tokensPerSecond = 400 } = options;
  const faux = fauxProvider({ models: [{ id, contextWindow, maxTokens }], tokensPerSecond });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: { provider: "faux", modelId: id } };
}

/** A fresh directory per test, removed after the file's last test: an earlier `afterEach` would delete it under open databases (macOS fails on that). */
export function tempDirPerTest(prefix: string): () => string {
  const made: string[] = [];
  let current = "";
  beforeEach(() => {
    current = mkdtempSync(join(tmpdir(), prefix));
    made.push(current);
  });
  afterAll(() => {
    for (const directory of made) rmSync(directory, { recursive: true, force: true });
  });
  return () => current;
}

const unavailable = (what: string) => async (): Promise<never> => Promise.reject(new Error(`${what} is not available in this test`));

/** What the modules' tools need, all in one place for tests. */
export type TestDeps = BaseDeps & {
  pages: PageFetcher;
  summarizer: PageSummarizer;
  memos: MemoStore;
  settings: ConversationSettings;
  /** Without a search service there is no `web_search` tool. */
  search?: SearchProvider;
  /** Without Gitea there is no issue tool. */
  gitea?: GiteaTools;
};

/** Tool dependencies for tests: nothing reaches a network or a model unless a test supplies it. */
export function toolDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  return {
    now: () => new Date(),
    startedAt: new Date(),
    version: "0.0.0-test",
    prompts: defaultPrompts,
    abortTask: async () => "terminal",
    pages: { fetch: unavailable("fetching a page") },
    summarizer: { answer: unavailable("answering from a page") },
    memos: { list: unavailable("the memo"), get: unavailable("the memo"), set: unavailable("the memo"), remove: unavailable("the memo") },
    // No setting registered, as in production: no settings tools.
    settings: new ConversationSettings(new SettingCatalog([]), {
      list: unavailable("the settings"),
      read: unavailable("the settings"),
      write: unavailable("the settings"),
      remove: unavailable("the settings"),
    }),
    ...overrides,
  };
}

/** Collect the lines of the service log while `work` runs. */
export async function captureLogs(work: () => Promise<unknown>): Promise<{ line: string; level: LogLevel }[]> {
  const lines: { line: string; level: LogLevel }[] = [];
  const previous = setLogSink((line, level) => void lines.push({ line, level }));
  try {
    await work();
  } finally {
    setLogSink(previous);
  }
  return lines;
}

/** An extension that continues the first final answer once with `text`, as an `onYield` hook does. */
export function continueOnce(text = "go on"): AgentExtension {
  let continued = false;
  return {
    name: "continue-once",
    hooks: [
      hook(GenerationTask, {
        onYield: () => {
          if (continued) return undefined;
          continued = true;
          return { continue: text };
        },
      }),
    ],
  };
}

/** In-memory `ChangeLog` for tests; can be made to fail. */
export class MemoryChangeLog implements ChangeLog {
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

export const memoryChangeLog = (): MemoryChangeLog => new MemoryChangeLog();
