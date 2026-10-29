import type { CommitPublication, ConversationId } from "@earendil-works/pi-durable";

import { log } from "../../platform/log.ts";
import { ChannelMap } from "../service/channel-map.ts";
import type { SessionReader } from "../service/reader.ts";
import { TIMERS_KEY } from "../service/timers.ts";
import { BUCKET_MS, type InsightsStore, type LedgerCommit, type SpendDelta } from "./records/index.ts";
import { addCounters, spendOf, zeroCounters } from "./usage.ts";

/** Conversations counted between two progress lines of the catch-up. */
const PROGRESS_EVERY = 500;

const CHANNEL_MAP_KIND = ChannelMap.definition.kind;

/**
 * Keeps the business database's spend and listing in step with Durable, which stays the only truth. A commit only marks
 * its conversation; counting reads that conversation's entries from its cursor on, so live work, recovery after a
 * crash and the first fill of an old history are the same code and counting twice is impossible.
 */
export class UsageLedger {
  readonly store: InsightsStore;
  readonly #dirty = new Set<number>();
  readonly #dirtyKeys = new Set<string>();
  #reader: SessionReader | undefined;
  #closed = false;
  /** The jobs run one after the other, a failed one included. */
  #tail: Promise<void> = Promise.resolve();
  /** The drain that has not started yet: marks that arrive before it starts ride along. */
  #waiting: Promise<void> | undefined;

  constructor(store: InsightsStore) {
    this.store = store;
  }

  /** Marks what a commit touched. Pass it as `onCommit`; it reads nothing, so it is safe in the commit callback. */
  readonly observe = (publication: CommitPublication): void => {
    if (this.#closed) return;
    let touched = false;
    for (const change of publication.changes) {
      if (change.type === "entry") {
        this.#dirty.add(change.value.conversationId);
        touched = true;
      } else if (change.type === "document" && change.record.kind === CHANNEL_MAP_KIND && change.record.key !== undefined) {
        this.#dirtyKeys.add(change.record.key);
        touched = true;
      }
    }
    if (touched && this.#reader) this.#schedule().catch((error: unknown) => log.error("insights.ledger_failed", {}, error));
  };

  /** Counts everything the cursors have not reached, then follows the commits. The first run over an old history counts all of it. */
  async start(reader: SessionReader): Promise<void> {
    this.#reader = reader;
    await this.#enqueue(() => this.#catchUp(reader));
  }

  /** Waits until everything committed so far is counted. Throws when the database refuses, with the work kept for the next try. */
  flush(): Promise<void> {
    return this.#schedule();
  }

  /** Stops following commits and waits for the job in hand; what is left is counted at the next start. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(job);
    this.#tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  #schedule(): Promise<void> {
    this.#waiting ??= this.#enqueue(async () => {
      this.#waiting = undefined;
      await this.#drain();
    });
    return this.#waiting;
  }

  async #drain(): Promise<void> {
    const reader = this.#reader;
    if (!reader) return;
    let failure: unknown;
    while (this.#dirty.size > 0 || this.#dirtyKeys.size > 0) {
      for (const key of [...this.#dirtyKeys]) {
        this.#dirtyKeys.delete(key);
        try {
          const id = await reader.conversationOf(key);
          if (id !== undefined) this.#dirty.add(id);
        } catch (error) {
          this.#dirtyKeys.add(key);
          failure ??= error;
        }
      }
      for (const id of [...this.#dirty]) {
        this.#dirty.delete(id);
        try {
          await this.#count(reader, id as ConversationId);
        } catch (error) {
          this.#dirty.add(id);
          failure ??= error;
        }
      }
      // A refusing database would only be asked again at once.
      if (failure !== undefined) throw failure;
    }
  }

  async #catchUp(reader: SessionReader): Promise<void> {
    const started = Date.now();
    let counted = 0;
    for await (const id of reader.conversations()) {
      await this.#count(reader, id);
      if (++counted % PROGRESS_EVERY === 0) log.info("insights.catching_up", { conversations: counted });
    }
    log.info("insights.caught_up", { conversations: counted, ms: Date.now() - started });
  }

  /** Counts the conversation's entries after its cursor and refreshes its row in the listing. */
  async #count(reader: SessionReader, id: ConversationId): Promise<void> {
    const cursor = await this.store.cursorOf(id);
    const key = cursor?.key ?? (await reader.keyOf(id)) ?? "";
    let lastEntryId = cursor?.lastEntryId ?? 0;
    const spend = new Map<string, SpendDelta>();
    let lastActiveAt: number | undefined;
    for await (const entry of reader.entries(id, { after: lastEntryId, order: "ascending" })) {
      lastEntryId = Math.max(lastEntryId, entry.id);
      for (const record of spendOf(entry)) {
        const bucket = Math.floor(record.at / BUCKET_MS);
        const slot = `${bucket}:${record.kind}:${record.name}`;
        const delta = spend.get(slot) ?? { bucket, kind: record.kind, name: record.name, usage: zeroCounters() };
        spend.set(slot, delta);
        addCounters(delta.usage, record.usage);
      }
      for (const message of entry.model ?? []) {
        if (typeof message.timestamp === "number") lastActiveAt = Math.max(lastActiveAt ?? message.timestamp, message.timestamp);
      }
    }
    // The timers' conversation is no chat, and a conversation its key no longer points at is stale.
    const listed = key !== "" && key !== TIMERS_KEY && (await reader.conversationOf(key)) === Number(id);
    const row = listed ? await this.store.listingOf(key) : undefined;
    const moved = listed && row?.conversationId !== Number(id);
    if (cursor && lastEntryId === cursor.lastEntryId && !moved) return;
    const commit: LedgerCommit = {
      conversationId: Number(id),
      key,
      lastEntryId,
      spend: [...spend.values()],
      ...(listed ? { listing: { lastActiveAt } } : {}),
    };
    await this.store.apply(commit);
  }
}
