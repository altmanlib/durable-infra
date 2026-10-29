import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Harness,
  LiveDoc,
  type ScanOrder,
  type Storage,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";

import { ChannelMap } from "./channel-map.ts";
import { ConversationKeys } from "./notices.ts";
import { Outbox, type PendingTurn } from "./outbox.ts";

const context = BACKGROUND_CONTEXT;
const PAGE = 200;

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

  /** The conversation's own entries, newest first unless `order` says otherwise; with `after`, only those with a greater ID. Inherited fork entries are left out so each is seen once. */
  async *entries(conversationId: ConversationId, options: { after?: number; order?: ScanOrder } = {}): AsyncIterable<EntryRecord> {
    let cursor: Cursor | undefined;
    const query: EntryQuery = {
      conversationId,
      ...(options.after === undefined ? {} : { minEntryId: (options.after + 1) as EntryId }),
      ...(options.order ? { order: options.order } : {}),
    };
    do {
      const page = await this.#storage.scanEntries(query, PAGE, cursor, context);
      for (const entry of page.items) if (entry.conversationId === conversationId) yield entry;
      cursor = page.next;
    } while (cursor !== undefined);
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
}
