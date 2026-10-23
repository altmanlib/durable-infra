import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, type Cursor, type EntryRecord, type Harness, LiveDoc, type Storage, UsageDoc, type UsageState } from "@earendil-works/pi-durable";

import type { ConversationInfo } from "./agent-service.ts";
import { ChannelMap } from "./channel-map.ts";
import { ConversationKeys } from "./notices.ts";
import { Outbox, type PendingTurn } from "./outbox.ts";
import { TIMERS_KEY } from "./timers.ts";

const context = BACKGROUND_CONTEXT;
const PAGE = 200;
/** Entries `lastActivity` looks at before giving up: bookkeeping entries carry no message. */
const RECENT_ENTRIES = 20;

/** Read-only queries over storage; never commits or schedules, so it is safe alongside running conversations. */
export class SessionReader {
  readonly #harness: Harness;
  readonly #storage: Storage;

  constructor(harness: Harness, storage: Storage) {
    this.#harness = harness;
    this.#storage = storage;
  }

  /** Every conversation ID, in ascending order. */
  async *conversations(): AsyncIterable<ConversationId> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.#storage.scanConversations({}, PAGE, cursor, context);
      for (const record of page.items) yield record.id;
      cursor = page.next;
    } while (cursor !== undefined);
  }

  /** The conversation's own entries, newest first; inherited fork entries are left out so each is seen once. */
  async *entries(conversationId: ConversationId): AsyncIterable<EntryRecord> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.#storage.scanEntries({ conversationId }, PAGE, cursor, context);
      for (const entry of page.items) if (entry.conversationId === conversationId) yield entry;
      cursor = page.next;
    } while (cursor !== undefined);
  }

  /** Time of the newest message among the last few entries, or undefined. */
  async lastActivity(conversationId: ConversationId): Promise<number | undefined> {
    let looked = 0;
    for await (const entry of this.entries(conversationId)) {
      const times = (entry.model ?? []).map((message) => message.timestamp).filter((at): at is number => typeof at === "number");
      if (times.length > 0) return Math.max(...times);
      if (++looked >= RECENT_ENTRIES) return undefined;
    }
    return undefined;
  }

  /** Spend Durable has counted across every conversation, including what no entry carries. */
  usage(): Promise<UsageState> {
    return this.#harness.usage(context);
  }

  /** The channel key a conversation was created for, or undefined for one without (a fork, say). */
  async keyOf(conversationId: ConversationId): Promise<string | undefined> {
    const key = (await this.#harness.snapshot(ConversationKeys, String(conversationId), context))?.key;
    return key === undefined || key === "" ? undefined : key;
  }

  /** The conversation a channel key currently points at; a conversation whose key points at a newer one is stale. */
  async conversationOf(key: string): Promise<number | undefined> {
    return (await this.#harness.snapshot(ChannelMap, key, context))?.conversationId;
  }

  /** Inputs accepted but not yet confirmed delivered, in arrival order. */
  async pendingInputs(): Promise<PendingTurn[]> {
    return (await this.#harness.snapshot(Outbox, context))?.items ?? [];
  }

  /** Whether an answer is being written or inputs are waiting. */
  async isBusy(conversationId: ConversationId): Promise<boolean> {
    return (await this.#harness.snapshot(LiveDoc, conversationId, context))?.run !== undefined;
  }

  /** Spend Durable has counted for this conversation alone, including what no entry carries. */
  async spent(conversationId: ConversationId): Promise<UsageState | undefined> {
    return this.#harness.snapshot(UsageDoc, conversationId, context);
  }

  /** Conversations with a channel key, most recently active first; forks and stale mappings are omitted. */
  async listConversations(): Promise<ConversationInfo[]> {
    const pending = await this.pendingInputs();
    const found: ConversationInfo[] = [];
    for await (const id of this.conversations()) {
      const key = await this.keyOf(id);
      // The conversation that owns the scheduled tasks is not a chat.
      if (!key || key === TIMERS_KEY) continue;
      if ((await this.conversationOf(key)) !== Number(id)) continue;
      const spent = await this.spent(id);
      const totalTokens = [...Object.values(spent?.models ?? {}), ...Object.values(spent?.tools ?? {})].reduce((sum, each) => sum + (each.totalTokens ?? 0), 0);
      const lastActiveAt = await this.lastActivity(id);
      found.push({
        key,
        busy: await this.isBusy(id),
        ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
        totalTokens,
        pending: pending.filter((item) => item.key === key).length,
      });
    }
    return found.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  }
}
