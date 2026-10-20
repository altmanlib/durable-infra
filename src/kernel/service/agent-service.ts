import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Models, ModelThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import {
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
import { moveToModel } from "./model-switch.ts";
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
  /**
   * Text increments in order. Their concatenation equals `text`, except when a retry rewrote text that had already
   * streamed; then the stream goes on with a blank line and the whole rewritten text.
   */
  readonly deltas: AsyncIterable<string>;
  /** Resolves with the final text once the answer is committed; rejects with `TurnFailed`. */
  readonly answer: Promise<string>;
  /**
   * Resolves with `answer` and the text each generation before it wrote (such as before a tool call), joined by a blank
   * line, the answer last; rejects as `answer` does. A channel that shows only the answer may ignore it.
   */
  readonly text: Promise<string>;
  /**
   * Tool calls of this turn as they start and finish, in order; ends with the turn. A channel may ignore it. A quick
   * call can be seen only as "running" or only as "done", so show "running" as progress, never rely on "done".
   */
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

/**
 * Everything a channel uses of the conversations: answering, its commands, replaying after a restart, and notices. A
 * channel takes this, never the whole service; a part of a channel takes a smaller Pick of it.
 */
export type ChannelService = Pick<
  AgentService,
  "send" | "reset" | "compact" | "history" | "delivered" | "pending" | "notices" | "onNotice" | "ackNotice" | "schedule" | "unschedule"
>;

/** What a channel with shared conversations, such as groups, uses besides that: recording what was not addressed to it, and keeping the context short. */
export type SharedChannelService = ChannelService & Pick<AgentService, "record" | "keepRecent">;

/** What a channel may say about an input besides its text. */
export type SendOptions = {
  /** Who wrote it, where a conversation has more than one person; kept for the replay too. */
  speaker?: Speaker;
  /**
   * The conversation is shared by several people, such as a group: created with `sharedTools` and `privilegedTools` only.
   * Kept with the pending input, so its run can be matched to the asker (`speakerOf`), after a replay too.
   */
  shared?: boolean;
  /**
   * In a shared conversation, the person who wrote it may use the `privilegedTools`; a run with any input without it
   * may not. The channel decides, such as by its access list; it is kept with the pending input, never in the conversation.
   */
  privileged?: boolean;
};

export type RecordOptions = {
  /** Who wrote it. */
  speaker?: Speaker;
  /** When it was written, in milliseconds; kept in the entry's data for views. */
  at?: number;
  /** As in `SendOptions`. */
  shared?: boolean;
  /** Said before the channel was there, such as a group's history fetched when the bot joins; kept in the entry's data. */
  backfill?: boolean;
};

export type { PendingTurn };

export type AgentServiceOptions = {
  databasePath: string;
  models: Models;
  /** Model of every conversation: new ones are created with it, and existing ones are moved to it at open (`moveToModel`). */
  model: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  settings?: HarnessSettings;
  /**
   * Extra extensions, such as tools, installed after the built-in `assistant` one. Built from the opened Harness, so a
   * tool can reach what only the Harness offers. Default none.
   */
  extensions?: (host: ExtensionHost) => readonly AgentExtension[];
  /**
   * The texts in force, which the console's edits go into; by default the kernel's own. Whatever else reads them (the
   * tools, the channels' welcomes) must be given the same instance, as `openCore` does.
   */
  prompts?: EditablePrompts;
  /** How many console changes the history keeps; the settings default when absent. Not used with `changes`. */
  maxSettingsChanges?: number;
  /**
   * Where the application keeps the history of changes (its business database, say). By default the history is a Durable
   * document written in the commit of each change; with this the change is noted here after its commit, and the
   * allowlist and `Settings.channel` are not available (kernel/settings/settings.ts).
   */
  changes?: ChangeLog;
  /** Flood guard per conversation; inputs over it are refused with `TurnFailed("rate_limited")`. Default 30 per 5 minutes. */
  rateLimit?: RateLimit;
  /** Tool rounds one turn may take before the model is asked to answer without more tools. Default 10. */
  maxToolRounds?: number;
  /** Clock for the date section and the rate limit; defaults to the system clock. */
  now?: () => Date;
  /**
   * The tools, by name, every person of a conversation several people share (`shared` on the call that creates it) may
   * use. With `privilegedTools` they are its only tools: stored in the conversation when it is created, and existing
   * shared conversations are moved to the current list at open (`moveToSharedTools`). A name not installed is left out.
   * Without it, a shared conversation has every tool.
   */
  sharedTools?: readonly string[];
  /**
   * Tools a shared conversation also has, but only a run whose inputs are all `privileged` may call (such as reminders);
   * a call in another run is refused with `tool.not-permitted`. Not checked in other conversations. Only with `sharedTools`.
   */
  privilegedTools?: readonly string[];
};

const context = BACKGROUND_CONTEXT;

/**
 * Today's date in the process time zone (TZ), without naming the zone (docs/design/2026-10-13-local-time.md). Day
 * granularity keeps the section stable within a day, so the provider prompt cache is invalidated at most once a day.
 */
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
  /** When a message was last sent or received; absent for a conversation with none. */
  lastActiveAt?: number;
  /** Everything the conversation has spent: its answers, compaction summaries and tools. */
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
  /** Read-only access to the stored data, for queries such as usage reports; channels do not need it. */
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
    // The task behind `schedule`; installed before the scheduler starts, so one left by an earlier run finds its code.
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
          // Only when a request offers no tools: some models then write tool-call markup as plain text instead of answering.
          section("no-tools", ({ agent }) => (agent.tools.length === 0 ? prompts.get("system.no-tools") : undefined), { tag: false }),
          section("speaker", () => prompts.get("system.speaker"), { tag: false }),
          section("shared", async ({ read, conversationId }) => ((await isShared(read, conversationId)) ? prompts.get("system.shared") : undefined), {
            tag: false,
          }),
          section("date", () => currentDateLine(options.now?.() ?? new Date()), { tag: false }),
        ],
      }),
    );
    const storage = await openNodeSqliteStorage(options.databasePath);
    const harness = await Harness.open(storage, { models: options.models, registry, settings: options.settings }, context);
    // Installed before the scheduler starts, so tasks left by an earlier run find their code.
    const host: ExtensionHost = { abortTask: (taskId) => harness.abortTask(taskId, context) };
    for (const extension of options.extensions?.(host) ?? []) registry.install(extension);
    const notices = await NoticeFeed.open(harness);
    const reader = new SessionReader(harness, storage);
    // Before work resumes and before the settings read the history this adds to.
    await moveToModel(harness, reader.conversations(), options.model, {
      now: () => (options.now?.() ?? new Date()).getTime(),
      maxChanges: options.maxSettingsChanges ?? MAX_CHANGES,
      ...(options.changes ? { changes: options.changes } : {}),
    });
    const sharedNames = AgentService.#sharedNames(options);
    if (sharedNames) await moveToSharedTools(harness, reader.conversations(), sharedToolsOf(registry.snapshot(), sharedNames));
    // Before work resumes, so no request renders a text that an edit has already replaced.
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

  /**
   * Submit user text. A repeated `requestId` for the same key returns the original turn instead of asking again.
   * Throws `RangeError` before anything is recorded when `options.speaker` breaks the attribute rules.
   */
  async send(key: ConversationKey, text: string, requestId: string, options: SendOptions = {}): Promise<Turn> {
    const speaker = options.speaker && normalizeSpeaker(options.speaker);
    if (!(await this.#admit(key, requestId))) {
      log.warn("turn.rate_limited", { key, requestId });
      // Nothing is recorded or submitted, so a refused input is not replayed after a restart.
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
      // What the item keeps, not this call's options: a replay after a restart does not pass `shared`.
      return (item.privileged === true || item.shared === true) && item.submission === undefined;
    }, context);
    const submission = await conversation.submit({ type: "input", content: userContent(text, speaker), requestId }, context);
    // So the run's inputs can be matched to their items (`shared-tools.ts`): the privileged tools hook, and who asked
    // (`speakerOf`); until then a privileged tool is refused and the asker is not known. Only an input of a shared
    // conversation pays for this commit, and a replay after a crash in between makes it.
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
        // The last partial lacks the tail of the answer; the committed entry completes it.
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
    // Adapters may only consume deltas; keep an unobserved failure from becoming an unhandled rejection.
    answer.catch(() => {});
    // `complete` has run by the time the answer resolves.
    const rounds = answer.then(() => feed.text);
    rounds.catch(() => {});

    return { requestId, deltas: feed.deltas, answer, text: rounds, tools: feed.tools };
  }

  /**
   * Record text in a conversation without asking the model anything, such as a message in a group that was not addressed
   * to the bot: a Durable write of a `chat.message` entry carrying a user message, so the model sees it with the next
   * question. An idle conversation appends it at once; a busy one places it at the next boundary, as a steer. A repeated
   * `requestId` for the same key is recorded once. Not rate limited and not in the outbox: nothing is answered.
   */
  async record(key: ConversationKey, text: string, requestId: string, options: RecordOptions = {}): Promise<void> {
    const speaker = options.speaker && normalizeSpeaker(options.speaker);
    const conversation = await this.#obtain(key, options.shared);
    const timestamp = options.at ?? (this.#options.now?.() ?? new Date()).getTime();
    const message: UserMessage = { role: "user", content: userContent(text, speaker), timestamp };
    const data = { at: timestamp, ...(options.backfill ? { backfill: true } : {}) };
    await conversation.submit({ type: "write", requestId, entry: { kind: ChatMessageEntry.kind, data, model: [message] } }, context);
  }

  /**
   * Keep the model's context to the most recent messages, such as in a group that records everything said
   * (docs/design/2026-10-19-group-chat.md §3.7). Messages are recorded ones (`chat.message`) and inputs. Over
   * `keep + slack` of them in the current context, a Durable write of a `chat.window` entry moves the start (`head`) to
   * the `keep`-th message from the end: always a user message, so a tool call is never parted from its result, and the
   * answers and tool rounds after it stay. Up to `keep + slack` nothing moves, so the provider's prompt cache is broken
   * only once every `slack` messages. A busy conversation places the write at its next boundary; one whose start has
   * moved past the target by then drops it (`stale`). Older entries stay in storage. A conversation that does not exist
   * is `kept`.
   */
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

  /**
   * Inputs of the keys `owns` accepts whose answers are not confirmed delivered, oldest first. Replay each
   * with `send(key, text, requestId)`, which returns the original turn, then call `delivered`.
   */
  async pending(owns: OwnsKey): Promise<PendingTurn[]> {
    const outbox = await this.#harness.snapshot(Outbox, context);
    return (outbox?.items ?? [])
      .filter((item) => owns(item.key))
      .map(({ key, requestId, text, speaker }) => ({ key, requestId, text, ...(speaker ? { speaker } : {}) }));
  }

  /**
   * Messages the service wants delivered without a user input behind them, such as due reminders, of the keys `owns`
   * accepts, oldest first. Send each, then call `ackNotice`; a notice is delivered at least once.
   */
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

  /**
   * Ask to be told about `event` for `key` at `at` (ms since epoch). It arrives as a notice of that key, like a due
   * reminder, and is delivered at least once: after a restart, and straight away when `at` has already passed. Returns the
   * ID to cancel it with; the notice has the same ID. The core never reads the event, so what it means is the channel's.
   */
  async schedule(key: ConversationKey, at: number, event: ScheduledEvent): Promise<string> {
    if (event.kind === "" || event.kind.length > MAX_EVENT_KIND_CHARS) throw new RangeError(`an event kind must be 1 to ${MAX_EVENT_KIND_CHARS} characters`);
    if (event.data.length > MAX_EVENT_DATA_CHARS) throw new RangeError(`event data may be at most ${MAX_EVENT_DATA_CHARS} characters`);
    if (!Number.isFinite(at)) throw new RangeError("the time of an event must be a number of milliseconds");
    const owner = await this.#obtain(TIMERS_KEY);
    const id = await owner.commit((tx) => tx.createTask(Timer, { key, event, at }, { ownership: { kind: "conversation" }, background: true }), context);
    return String(id);
  }

  /**
   * Withdraw an event before it fires. `gone` is every other case: it already fired (its notice is waiting to be
   * confirmed, or was), it was cancelled, or there never was one. A channel that acts on a notice must therefore
   * tolerate one it no longer needs; this only saves it the work.
   */
  async unschedule(id: string): Promise<"cancelled" | "gone"> {
    const taskId = Number(id) as TaskId;
    const task = Number.isSafeInteger(taskId) ? await this.#harness.getTask(taskId, context) : undefined;
    if (task?.kind !== TIMER_TASK) return "gone";
    return (await this.#harness.abortTask(taskId, context)) === "marked" ? "cancelled" : "gone";
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

  /**
   * Every conversation that has a channel key, most recently active first. Forks and conversations whose key now points
   * at a newer one (a stale mapping) are left out: they cannot be addressed by key.
   */
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
