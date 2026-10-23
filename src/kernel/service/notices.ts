import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";

import { appDoc, appDocFamily, checkpoint } from "../app-docs.ts";

const context = BACKGROUND_CONTEXT;

/** What a channel scheduled (`AgentService.schedule`); the core stores it without reading it. */
export type ScheduledEvent = {
  /** What it is, in the channel's words, such as `captcha_timeout`. */
  kind: string;
  data: string;
};

type NoticeBase = {
  /** Unique and stable; the channel confirms with it. */
  id: string;
  /** Channel-neutral conversation key the notice belongs to. */
  key: string;
  /** When the notice was meant to fire (ms since epoch); later than this when the process was offline. */
  dueAt: number;
};

/** A message to send (such as a due reminder) or a scheduled event, for the channel to act on. */
export type Notice = (NoticeBase & { text: string }) | (NoticeBase & { event: ScheduledEvent });

/** Whether a notice is an event a channel scheduled, not a message to send. */
export const isEvent = (notice: Notice): notice is NoticeBase & { event: ScheduledEvent } => "event" in notice;

/** Notices not yet confirmed delivered, in the order they fired. Written by core tasks, read by `NoticeFeed`. */
export const Notices = appDoc<{ items: Notice[] }>({
  kind: "app.notices",
  version: 1,
  initial: () => ({ items: [] }),
  // A base once empty, so reads never replay confirmed notices.
  checkpoint: checkpoint.whenEmpty(100),
});

/** Conversation ID to channel key, the reverse of `ChannelMap`, so a tool can tell which chat is calling. */
export const ConversationKeys = appDocFamily<{ key: string }, string>({
  kind: "app.conversation-key",
  version: 1,
  initial: () => ({ key: "" }),
  checkpoint: checkpoint.every(50),
});

/** Fan-out of newly fired notices to channel adapters. A single-purpose callback list, not an event bus. */
export class NoticeFeed {
  readonly #harness: Harness;
  readonly #listeners = new Set<(notice: Notice) => void>();
  readonly #seen: Set<string>;
  #stop: (() => Promise<unknown>) | undefined;

  private constructor(harness: Harness, seen: Set<string>) {
    this.#harness = harness;
    this.#seen = seen;
  }

  static async open(harness: Harness): Promise<NoticeFeed> {
    // A watch cannot be acquired on a document that does not exist yet.
    await harness.commit(async (tx) => {
      await tx.doc(Notices);
    }, context);
    const watch = await harness.watchDoc(Notices, context);
    const feed = new NoticeFeed(harness, new Set((watch?.value?.items ?? []).map((item) => item.id)));
    if (watch) {
      watch.start(async (value) => {
        for (const item of value?.items ?? []) {
          if (feed.#seen.has(item.id)) continue;
          feed.#seen.add(item.id);
          for (const listener of feed.#listeners) listener({ ...item });
        }
      });
      feed.#stop = () => watch.stop();
    }
    return feed;
  }

  /** Notices not yet confirmed, oldest first. */
  async list(): Promise<Notice[]> {
    const doc = await this.#harness.snapshot(Notices, context);
    return (doc?.items ?? []).map((item) => ({ ...item }));
  }

  /** Call `listener` for each notice that fires from now on. Returns the unsubscribe function. */
  subscribe(listener: (notice: Notice) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async ack(id: string): Promise<void> {
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(Notices);
      const index = doc.items.findIndex((item) => item.id === id);
      if (index >= 0) doc.items.splice(index, 1);
    }, context);
    this.#seen.delete(id);
  }

  async close(): Promise<void> {
    await this.#stop?.();
    this.#listeners.clear();
  }
}
