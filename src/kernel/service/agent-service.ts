import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Models, ModelThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  type Conversation,
  type ConversationId,
  createRegistry,
  defineExtension,
  Harness,
  type HarnessSettings,
  LiveDoc,
  type LiveState,
  type ModelRef,
  type Registry,
  section,
  type TaskId,
  UserEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { log } from "../../platform/log.ts";
import { SlidingWindow } from "../../platform/sliding-window.ts";
import { EditablePrompts, KERNEL_PROMPTS, PromptCatalog } from "../prompts.ts";
import type { ChangeLog } from "../settings/change-log.ts";
import { MAX_CHANGES } from "../settings/docs.ts";
import { Settings } from "../settings/settings.ts";
import { ChannelMap } from "./channel-map.ts";
import type { AgentExtension, ExtensionHost } from "./host.ts";
import { checkCatalog, modelName, moveToModel, type SetModelResult, sameModel, selectModel } from "./model-switch.ts";
import { ConversationKeys, type Notice, NoticeFeed, type ScheduledEvent } from "./notices.ts";
import { Outbox, type PendingTurn } from "./outbox.ts";
import { DEFAULT_RATE_LIMIT, type RateLimit } from "./rate-limit.ts";
import { SessionReader } from "./reader.ts";
import { isShared, moveToSharedTools, privilegedToolsHook, sharedAgent, sharedToolsOf } from "./shared-tools.ts";
import { MAX_EVENT_DATA_CHARS, MAX_EVENT_KIND_CHARS, TIMER_TASK, TIMERS_KEY, Timer } from "./timers.ts";
import { DEFAULT_MAX_TOOL_ROUNDS, toolBudgetHook } from "./tool-budget.ts";
import { assistantText, ChatMessageEntry, type HistoryLine, historyLines, normalizeSpeaker, type Speaker, userContent, WindowEntry } from "./transcript.ts";
import { type ToolActivity, TurnFeed } from "./turn-feed.ts";

/** Channel-neutral conversation key such as "<channel>:<id>" or "terminal". */
export type ConversationKey = string;

/** One answered input: streamed text increments, then the committed final text. */
export interface Turn {
  readonly requestId: string;
  /** Text increments; a retry that rewrote streamed text continues with a blank line and the full text. */
  readonly deltas: AsyncIterable<string>;
  /** Final text once committed; rejects with `TurnFailed`. */
  readonly answer: Promise<string>;
  /** Text of every generation (before tool calls too), joined by blank lines, the answer last. */
  readonly text: Promise<string>;
  /** Tool calls as they start and finish; a quick call may show only "running" or only "done". */
  readonly tools: AsyncIterable<ToolActivity>;
}

/** An input that settled without an answer, such as a failed model call or an abort. */
export class TurnFailed extends Error {
  constructor(
    readonly reason: string,
    readonly detail?: unknown,
  ) {
    super(`turn failed: ${reason}`);
    this.name = "TurnFailed";
  }
}

export type CompactOutcome = "compacted" | "skipped";

/** Which conversation keys a channel answers for; it replays and delivers only those. */
export type OwnsKey = (key: ConversationKey) => boolean;

export type { SetModelResult };

/** Shows and changes a conversation's model; the choice is a person's, never the model's. */
export type ModelService = Pick<AgentService, "models" | "modelOf" | "setModel">;

/** What a channel uses of the conversations; sub-parts of a channel take a smaller `Pick`. */
export type ChannelService = Pick<
  AgentService,
  "send" | "reset" | "compact" | "history" | "delivered" | "pending" | "notices" | "onNotice" | "ackNotice" | "schedule" | "unschedule"
>;

/** What a channel with shared conversations (such as groups) also uses: recording and trimming context. */
export type SharedChannelService = ChannelService & Pick<AgentService, "record" | "keepRecent">;

/** What a channel may say about an input besides its text. */
export type SendOptions = {
  /** Who wrote it, in a conversation with several people; kept for replays. */
  speaker?: Speaker;
  /** The conversation is shared by several people, such as a group. */
  shared?: boolean;
  /** The speaker may use `privilegedTools` in a shared conversation; the channel decides. */
  privileged?: boolean;
};

export type RecordOptions = {
  /** Who wrote it. */
  speaker?: Speaker;
  /** When it was written, in milliseconds; kept in the entry's data for views. */
  at?: number;
  /** As in `SendOptions`. */
  shared?: boolean;
  /** Said before the channel existed, such as a group's history fetched on join. */
  backfill?: boolean;
};

export type { PendingTurn };

export type AgentServiceOptions = {
  databasePath: string;
  models: Models;
  /** Default model; new conversations use it, and conversations on models outside `catalog` move to it at open. */
  model: ModelRef;
  /** Models `setModel` may switch between; all share the default's provider and must include it. Default: the default model only. */
  catalog?: readonly ModelRef[];
  thinkingLevel?: ModelThinkingLevel;
  settings?: HarnessSettings;
  /** Extra extensions (such as tools) installed after the built-in `assistant` one; built from the opened Harness. */
  extensions?: (host: ExtensionHost) => readonly AgentExtension[];
  /** Texts the console edits; anything else reading them must get the same instance. */
  prompts?: EditablePrompts;
  /** How many console changes the history keeps; the settings default when absent. Not used with `changes`. */
  maxSettingsChanges?: number;
  /** Change-history store; by default a Durable document. With this, `Settings.access` and `Settings.channel` are unavailable. */
  changes?: ChangeLog;
  /** Flood guard per conversation; inputs over it are refused with `TurnFailed("rate_limited")`. Default 30 per 5 minutes. */
  rateLimit?: RateLimit;
  /** Tool rounds one turn may take before the model is asked to answer without more tools. Default 10. */
  maxToolRounds?: number;
  /** Clock for the date section and the rate limit; defaults to the system clock. */
  now?: () => Date;
  /** Tool names a shared conversation may use (all tools when absent); stored at creation, moved to this list at open. */
  sharedTools?: readonly string[];
  /** Tools only runs whose inputs are all `privileged` may call in shared conversations; others get `tool.not-permitted`. */
  privilegedTools?: readonly string[];
};

const context = BACKGROUND_CONTEXT;

/** Today's date in the process time zone; day granularity breaks the prompt cache at most once a day. */
export function currentDateLine(now: Date): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now);
  return `Today is ${date} (${weekday}).`;
}

/** One conversation as the console lists it. */
export type ConversationInfo = {
  /** The channel key, such as `<channel>:<id>`. */
  key: ConversationKey;
  /** An answer is being written or inputs are waiting. */
  busy: boolean;
  /** Last message time in ms; absent when there is none. */
  lastActiveAt?: number;
  /** Total tokens spent: answers, compaction summaries and tools. */
  totalTokens: number;
  /** Inputs accepted but not yet confirmed delivered to the user. */
  pending: number;
};

/** Owns the Harness and maps channel keys to Durable conversations. Channels reach Durable only through this class. */
export class AgentService {
  readonly #harness: Harness;
  readonly #options: AgentServiceOptions;
  readonly #notices: NoticeFeed;
  readonly #limiter: SlidingWindow;
  #registry: Registry | undefined;
  /** Get-or-create per key, shared by concurrent callers so one key never creates two conversations. */
  readonly #conversations = new Map<ConversationKey, Promise<Conversation>>();
  /** Read-only stored data, for queries such as usage reports. */
  readonly reader: SessionReader;
  /** What an operator changes without a deploy; the console reads and writes it. */
  readonly settings: Settings;

  private constructor(harness: Harness, options: AgentServiceOptions, notices: NoticeFeed, reader: SessionReader, settings: Settings) {
    this.#harness = harness;
    this.reader = reader;
    this.settings = settings;
    this.#options = options;
    this.#notices = notices;
    this.#limiter = new SlidingWindow(options.rateLimit ?? DEFAULT_RATE_LIMIT);
  }

  /** Open the storage and resume work an earlier process left unfinished. */
  static async open(options: AgentServiceOptions): Promise<AgentService> {
    await mkdir(dirname(options.databasePath), { recursive: true });
    const registry = createRegistry();
    // Task behind `schedule`.
    registry.install(defineExtension({ name: "core-timers", tasks: [Timer] }));
    const prompts = options.prompts ?? new EditablePrompts(new PromptCatalog([KERNEL_PROMPTS]));
    registry.install(
      defineExtension({
        name: "assistant",
        hooks: [
          toolBudgetHook(options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS, prompts),
          ...(options.sharedTools && options.privilegedTools ? [privilegedToolsHook(options.privilegedTools, prompts)] : []),
        ],
        sections: [
          section("preamble", () => prompts.get("system.preamble"), { tag: false }),
          // Some models write tool-call markup as text when no tools are offered.
          section("no-tools", ({ agent }) => (agent.tools.length === 0 ? prompts.get("system.no-tools") : undefined), { tag: false }),
          section("speaker", () => prompts.get("system.speaker"), { tag: false }),
          section("shared", async ({ read, conversationId }) => ((await isShared(read, conversationId)) ? prompts.get("system.shared") : undefined), {
            tag: false,
          }),
          section("date", () => currentDateLine(options.now?.() ?? new Date()), { tag: false }),
        ],
      }),
    );
    // Fail fast before opening storage.
    const catalog = checkCatalog(options.models, options.model, options.catalog);
    const storage = await openNodeSqliteStorage(options.databasePath);
    const harness = await Harness.open(storage, { models: options.models, registry, settings: options.settings }, context);
    // Before the scheduler starts, so leftover tasks find their code.
    const host: ExtensionHost = { abortTask: (taskId) => harness.abortTask(taskId, context) };
    for (const extension of options.extensions?.(host) ?? []) registry.install(extension);
    const notices = await NoticeFeed.open(harness);
    const reader = new SessionReader(harness, storage);
    // Before work resumes and before settings read this history.
    await moveToModel(harness, reader.conversations(), options.model, {
      now: () => (options.now?.() ?? new Date()).getTime(),
      maxChanges: options.maxSettingsChanges ?? MAX_CHANGES,
      catalog,
      ...(options.changes ? { changes: options.changes } : {}),
    });
    const sharedNames = AgentService.#sharedNames(options);
    if (sharedNames) await moveToSharedTools(harness, reader.conversations(), sharedToolsOf(registry.snapshot(), sharedNames));
    // Before work resumes, so requests never render replaced texts.
    const settings = await Settings.open(harness, storage, {
      prompts,
      now: () => (options.now?.() ?? new Date()).getTime(),
      maxChanges: options.maxSettingsChanges,
      ...(options.changes ? { changes: options.changes } : {}),
    });
    harness.resume();
    const service = new AgentService(harness, options, notices, reader, settings);
    service.#registry = registry;
    return service;
  }

  /** Submit user text; a repeated `requestId` returns the original turn. Throws `RangeError` before recording if `speaker` is invalid. */
  async send(key: ConversationKey, text: string, requestId: string, options: SendOptions = {}): Promise<Turn> {
    const speaker = options.speaker && normalizeSpeaker(options.speaker);
    if (!(await this.#admit(key, requestId))) {
      log.warn("turn.rate_limited", { key, requestId });
      // Nothing recorded, so the refused input is not replayed after a restart.
      const answer = Promise.reject(new TurnFailed("rate_limited"));
      answer.catch(() => {});
      const closed = TurnFeed.closed();
      return { requestId, deltas: closed.deltas, answer, text: answer, tools: closed.tools };
    }
    const conversation = await this.#obtain(key, options.shared);
    // Record the input before submitting it, so a crash in between can still be replayed from the outbox.
    const unmatched = await this.#harness.commit(async (tx) => {
      const outbox = await tx.doc(Outbox);
      let item = outbox.items.find((candidate) => candidate.key === key && candidate.requestId === requestId);
      if (!item) {
        item = speaker ? { key, requestId, text, speaker } : { key, requestId, text };
        if (options.privileged) item.privileged = true;
        if (options.shared) item.shared = true;
        outbox.items.push(item);
      }
      // Use what the item stores; a replay has no `shared` option.
      return (item.privileged === true || item.shared === true) && item.submission === undefined;
    }, context);
    const submission = await conversation.submit({ type: "input", content: userContent(text, speaker), requestId }, context);
    // Match the run's inputs to their items (see `shared-tools.ts`); only shared inputs need this commit.
    if (unmatched) {
      await this.#harness.commit(async (tx) => {
        const item = (await tx.doc(Outbox)).items.find((candidate) => candidate.key === key && candidate.requestId === requestId);
        if (item) item.submission = Number(submission.id);
      }, context);
    }
    const feed = new TurnFeed(submission.id);
    const started = Date.now();

    // Partials are cumulative, so attaching after submit loses nothing.
    const view = await conversation.viewState(context);
    const unsubscribe = view.subscribe((value) =>
      feed.observe(value.docs[LiveDoc.definition.kind] as LiveState | undefined, (task) =>
        assistantText(value.entries.findLast((entry) => entry.byTaskId === task && AssistantEntry.is(entry))),
      ),
    );

    const answer = (async () => {
      try {
        const settled = await submission.wait(context);
        if (settled.status === "unanswered") throw new TurnFailed(settled.reason, settled.detail);
        if (settled.type !== "input") throw new TurnFailed(`unexpected ${settled.type} submission`);
        const answerId = settled.answer;
        const entry = await conversation.commit((tx) => tx.entry(answerId), context);
        unsubscribe();
        // The last partial lacks the answer's tail; the committed entry has it.
        const final = assistantText(entry) ?? "";
        feed.complete(final);
        const usage = (entry && AssistantEntry.is(entry) ? (entry.model?.[0] as AssistantMessage | undefined) : undefined)?.usage;
        log.info("turn.done", { key, requestId, ms: Date.now() - started, toolCalls: feed.toolCalls, inputTokens: usage?.input, outputTokens: usage?.output });
        return final;
      } catch (error) {
        if (error instanceof TurnFailed) log.warn("turn.failed", { key, requestId, reason: error.reason, ms: Date.now() - started });
        throw error;
      } finally {
        unsubscribe();
        view.dispose();
        feed.end();
      }
    })();
    // Adapters may consume only deltas; silence unobserved rejections.
    answer.catch(() => {});
    // `complete` has run by the time the answer resolves.
    const rounds = answer.then(() => feed.text);
    rounds.catch(() => {});

    return { requestId, deltas: feed.deltas, answer, text: rounds, tools: feed.tools };
  }

  /** Record a user message without asking the model (such as an unaddressed group message); not rate limited, not in the outbox. */
  async record(key: ConversationKey, text: string, requestId: string, options: RecordOptions = {}): Promise<void> {
    const speaker = options.speaker && normalizeSpeaker(options.speaker);
    const conversation = await this.#obtain(key, options.shared);
    const timestamp = options.at ?? (this.#options.now?.() ?? new Date()).getTime();
    const message: UserMessage = { role: "user", content: userContent(text, speaker), timestamp };
    const data = { at: timestamp, ...(options.backfill ? { backfill: true } : {}) };
    await conversation.submit({ type: "write", requestId, entry: { kind: ChatMessageEntry.kind, data, model: [message] } }, context);
  }

  /** Keep only the recent messages in context: once over `keep + slack`, move the start to the `keep`-th from the end, at a user message. */
  async keepRecent(key: ConversationKey, keep: number, slack: number): Promise<"moved" | "kept"> {
    const conversation = await this.#find(key);
    if (!conversation || keep < 1) return "kept";
    const { entries } = await conversation.context(context);
    const messages = entries.filter((entry) => ChatMessageEntry.is(entry) || UserEntry.is(entry));
    if (messages.length <= keep + slack) return "kept";
    const start = messages[messages.length - keep];
    if (!start) return "kept";
    await conversation.submit(
      { type: "write", requestId: `window:${start.id}`, entry: { kind: WindowEntry.kind, head: start.id, data: { kept: keep } } },
      context,
    );
    log.info("agent.window_moved", { key, messages: messages.length, kept: keep });
    return "moved";
  }

  /** Whether this input may start a turn. A replay of an input already accepted always may. */
  async #admit(key: ConversationKey, requestId: string): Promise<boolean> {
    const outbox = await this.#harness.snapshot(Outbox, context);
    if (outbox?.items.some((item) => item.key === key && item.requestId === requestId)) return true;
    return this.#limiter.tryStart(key, (this.#options.now?.() ?? new Date()).getTime());
  }

  /** Confirm that the answer to `requestId` reached the user; it is no longer replayed after a restart. */
  async delivered(key: ConversationKey, requestId: string): Promise<void> {
    await this.#harness.commit(async (tx) => {
      const outbox = await tx.doc(Outbox);
      const index = outbox.items.findIndex((item) => item.key === key && item.requestId === requestId);
      if (index >= 0) outbox.items.splice(index, 1);
    }, context);
  }

  /** Inputs of `owns` keys whose answers are not confirmed delivered, oldest first; replay each with `send`, then `delivered`. */
  async pending(owns: OwnsKey): Promise<PendingTurn[]> {
    const outbox = await this.#harness.snapshot(Outbox, context);
    return (outbox?.items ?? [])
      .filter((item) => owns(item.key))
      .map(({ key, requestId, text, speaker }) => ({ key, requestId, text, ...(speaker ? { speaker } : {}) }));
  }

  /** Undelivered notices (such as due reminders) of `owns` keys, oldest first; ack each after delivery. */
  async notices(owns: OwnsKey): Promise<Notice[]> {
    return (await this.#notices.list()).filter((notice) => owns(notice.key));
  }

  /** Call `listener` for each notice that fires from now on, for every key. Returns the unsubscribe function. */
  onNotice(listener: (notice: Notice) => void): () => void {
    return this.#notices.subscribe(listener);
  }

  /** Confirm that the notice reached the user; it is no longer replayed after a restart. */
  async ackNotice(id: string): Promise<void> {
    await this.#notices.ack(id);
  }

  /** Fire `event` for `key` at `at` (ms); delivered at least once as a notice. Returns the ID to cancel with. */
  async schedule(key: ConversationKey, at: number, event: ScheduledEvent): Promise<string> {
    if (event.kind === "" || event.kind.length > MAX_EVENT_KIND_CHARS) throw new RangeError(`an event kind must be 1 to ${MAX_EVENT_KIND_CHARS} characters`);
    if (event.data.length > MAX_EVENT_DATA_CHARS) throw new RangeError(`event data may be at most ${MAX_EVENT_DATA_CHARS} characters`);
    if (!Number.isFinite(at)) throw new RangeError("the time of an event must be a number of milliseconds");
    const owner = await this.#obtain(TIMERS_KEY);
    const id = await owner.commit((tx) => tx.createTask(Timer, { key, event, at }, { ownership: { kind: "conversation" }, background: true }), context);
    return String(id);
  }

  /** Cancel an event before it fires; `gone` covers already fired, already cancelled, or unknown. */
  async unschedule(id: string): Promise<"cancelled" | "gone"> {
    const taskId = Number(id) as TaskId;
    const task = Number.isSafeInteger(taskId) ? await this.#harness.getTask(taskId, context) : undefined;
    if (task?.kind !== TIMER_TASK) return "gone";
    return (await this.#harness.abortTask(taskId, context)) === "marked" ? "cancelled" : "gone";
  }

  /** The models `setModel` accepts; the default model is one of them. */
  models(): readonly ModelRef[] {
    return checkCatalog(this.#options.models, this.#options.model, this.#options.catalog);
  }

  /** The model the conversation of `key` asks next; the default model when it has none yet. */
  async modelOf(key: ConversationKey): Promise<ModelRef> {
    const conversation = await this.#find(key);
    const stored = conversation && (await this.#harness.snapshot(AgentDoc, conversation.id, context))?.model;
    return stored ?? this.#options.model;
  }

  /** Move the conversation to a catalog model from its next request; `unknown_model` or `unchanged` otherwise. Recorded in the history. */
  async setModel(key: ConversationKey, model: ModelRef, options: { shared?: boolean } = {}): Promise<SetModelResult> {
    const wanted = this.models().find((entry) => sameModel(entry, model));
    if (!wanted) return "unknown_model";
    const conversation = await this.#obtain(key, options.shared);
    const { from, moved } = await selectModel(this.#harness, conversation.id, wanted);
    if (!moved) return "unchanged";
    // Committed first, noted after: a failure of the note leaves the move standing.
    try {
      await this.settings.recordModelChange(key, from ? modelName(from) : null, modelName(wanted));
    } catch (error) {
      log.error("changes.record_failed", { area: "conversation-model", target: key }, error);
    }
    log.info("agent.model_set", { conversation: key, from: from ? modelName(from) : "none", to: modelName(wanted) });
    return "saved";
  }

  /** Start a new model context, optionally carrying a handoff note. Older entries stay in storage. */
  async reset(key: ConversationKey, handoff?: string): Promise<void> {
    const conversation = await this.#find(key);
    await conversation?.reset(handoff, context);
  }

  /** Summarize older context and wait until the summary is placed. */
  async compact(key: ConversationKey, instructions?: string): Promise<CompactOutcome> {
    const conversation = await this.#find(key);
    if (!conversation) return "skipped";
    const taskId = await conversation.compact(instructions, context);
    const { outcome } = (await this.#harness.waitForTask(taskId, context)).state;
    if (outcome.status !== "completed") throw new Error(`compaction ${outcome.status}`);
    if (outcome.result.entryId !== undefined) return "compacted";
    if (outcome.result.submissionId === undefined) return "skipped";
    const placed = await (await this.#harness.submission(outcome.result.submissionId, context))?.wait(context);
    return placed?.status === "done" ? "compacted" : "skipped";
  }

  /** Up to `limit` most recent user/assistant lines in chronological order, across resets. */
  async history(key: ConversationKey, limit: number): Promise<HistoryLine[]> {
    const conversation = await this.#find(key);
    if (!conversation || limit <= 0) return [];
    const lines: HistoryLine[] = [];
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries({}, Math.max(limit * 2, 20), cursor, context);
      lines.unshift(...historyLines(page.items));
      cursor = page.next;
    } while (lines.length < limit && cursor !== undefined);
    return lines.slice(-limit);
  }

  /** Conversations with a channel key, most recently active first; forks and stale mappings are omitted. */
  conversations(): Promise<ConversationInfo[]> {
    return this.reader.listConversations();
  }

  /** Withdraw queued inputs and stop the running answer. */
  async abort(key: ConversationKey): Promise<void> {
    const conversation = await this.#find(key);
    await conversation?.abort(context);
  }

  /** Wait until no conversation has unfinished work, such as runs resumed at open. */
  async waitForIdle(): Promise<void> {
    await this.#harness.waitForIdle(context);
  }

  async close(): Promise<void> {
    await this.#notices.close();
    await this.#harness.close(context);
  }

  /** Existing conversation of `key`, without creating one. */
  async #find(key: ConversationKey): Promise<Conversation | undefined> {
    const pending = this.#conversations.get(key);
    if (pending) return pending;
    return this.#lookup(key);
  }

  async #lookup(key: ConversationKey): Promise<Conversation | undefined> {
    const mapped = await this.#harness.snapshot(ChannelMap, key, context);
    if (!mapped) return undefined;
    return this.#harness.conversation(mapped.conversationId as ConversationId, context);
  }

  #obtain(key: ConversationKey, shared = false): Promise<Conversation> {
    let pending = this.#conversations.get(key);
    if (!pending) {
      pending = (async () => (await this.#lookup(key)) ?? this.#create(key, shared))();
      this.#conversations.set(key, pending);
      pending.catch(() => this.#conversations.delete(key));
    }
    return pending;
  }

  /** The tool names of shared conversations, or `undefined` when they have every tool. */
  static #sharedNames(options: AgentServiceOptions) {
    return options.sharedTools ? { shared: options.sharedTools, privileged: options.privilegedTools ?? [] } : undefined;
  }

  #create(key: ConversationKey, shared: boolean): Promise<Conversation> {
    const { model, thinkingLevel = "minimal" } = this.#options;
    const names = shared ? AgentService.#sharedNames(this.#options) : undefined;
    const tools = names && (this.#registry ? sharedToolsOf(this.#registry.snapshot(), names) : []);
    if (tools) log.info("agent.shared_conversation", { key, tools: tools.map((tool) => tool.name).join(",") });
    return this.#harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model, thinkingLevel, ...(tools ? sharedAgent(tools) : {}) },
        init: async (tx, id) => {
          // Overwrites a stale mapping whose conversation no longer exists.
          (await tx.doc(ChannelMap, key, id)).conversationId = id;
          (await tx.doc(ConversationKeys, String(id), String(id))).key = key;
        },
      },
      context,
    );
  }
}
