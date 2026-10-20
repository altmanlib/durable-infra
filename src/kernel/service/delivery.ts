import { log } from "../../platform/log.ts";
import type { AgentService, ConversationKey, OwnsKey } from "./agent-service.ts";
import { TurnFailed } from "./agent-service.ts";
import { isEvent, type Notice, type ScheduledEvent } from "./notices.ts";

/**
 * Delivery that every channel needs and that does not depend on how a channel talks to its users: replaying answers that were never confirmed delivered, and delivering notices that fire without a user input.
 * A channel says which keys are its own, how to send text to the user behind a key, and its texts; the rules of order,
 * confirmation and retry live here once.
 */

/**
 * Sends text to the user behind a conversation key; throws when it was not sent. Replay passes the pending input's
 * `requestId` so a channel can tie the answer to the original message (for example to schedule deleting it); notices
 * omit it.
 */
export type SendToKey = (key: ConversationKey, text: string, requestId?: string) => Promise<void>;

/** What a user reads instead of an answer: the stand-in for an empty one, and why there is none. */
export type AnswerTexts = { empty: string; failure: (reason: string) => string };

/** The text a finished turn shows the user: the answer, the stand-in for an empty one, or why there is none. */
export function answerText(answer: Promise<string>, texts: AnswerTexts): Promise<string> {
  return answer.then(
    (value) => (value.trim() === "" ? texts.empty : value),
    (error: unknown) => {
      if (error instanceof TurnFailed) return texts.failure(error.reason);
      throw error;
    },
  );
}

export type ReplayService = Pick<AgentService, "pending" | "send" | "delivered">;

export type ReplayOptions = {
  /** The channel, as the prefix of its log events (`<channel>.replay.sent`). */
  channel: string;
  /** The keys to replay: the channel's own, or fewer. */
  owns: OwnsKey;
  send: SendToKey;
  texts: AnswerTexts;
  /** Inputs being answered right now by this run; they are not replayed. */
  skip?: (requestId: string) => boolean;
};

/**
 * Deliver the answers of inputs that were accepted but never confirmed delivered. Replies are sent whole. Keys are
 * replayed in parallel and the inputs of one key in arrival order; a reply that cannot be sent stays pending, and so do
 * the later ones of its key, until the next replay. Returns how many were delivered.
 */
export async function replayPending(service: ReplayService, options: ReplayOptions): Promise<number> {
  const { channel, owns, send, texts, skip } = options;
  const byKey = new Map<ConversationKey, Awaited<ReturnType<ReplayService["pending"]>>>();
  for (const item of await service.pending(owns)) {
    if (skip?.(item.requestId)) continue;
    byKey.set(item.key, [...(byKey.get(item.key) ?? []), item]);
  }

  let delivered = 0;
  await Promise.all(
    [...byKey].map(async ([key, items]) => {
      for (const item of items) {
        try {
          const turn = await service.send(item.key, item.text, item.requestId, item.speaker ? { speaker: item.speaker } : {});
          await send(key, await answerText(turn.answer, texts), item.requestId);
          await service.delivered(item.key, item.requestId);
          delivered++;
          log.info(`${channel}.replay.sent`, { requestId: item.requestId, key });
        } catch (error) {
          log.error(`${channel}.replay.failed`, { requestId: item.requestId, key }, error);
          // Keep the order within a key: later inputs wait for the next replay.
          return;
        }
      }
    }),
  );
  return delivered;
}

export type NoticeService = Pick<AgentService, "notices" | "onNotice" | "ackNotice">;

export type NoticeOptions = {
  /** The channel, as the prefix of its log events (`<channel>.notice.delivered`). */
  channel: string;
  owns: OwnsKey;
  send: SendToKey;
  /**
   * What the channel does when an event it scheduled (`AgentService.schedule`) comes due. It is run again if it throws
   * and, like a send, once more after a crash between doing it and confirming it, so it must do no harm done twice.
   * A channel that schedules nothing leaves it out.
   */
  handle?: (key: ConversationKey, event: ScheduledEvent) => Promise<void>;
  /**
   * Why sending to this user is pointless for now (a reason for the log), or undefined for an ordinary failure. Such a
   * notice is not retried on the clock; it waits for `retry` or the next start.
   */
  waiting?: (error: unknown) => string | undefined;
  /** Waits between attempts to send one notice; a notice still unsent afterwards waits for `retry` or the next start. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

export type Notices = {
  /** Stop listening for new notices. */
  stop(): void;
  /** Try again the unsent notices of the keys `owns` accepts, such as a user's after the user wrote. */
  retry(owns: OwnsKey): Promise<void>;
  /** Resolves when everything queued has been tried. */
  idle(): Promise<void>;
};

const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

/**
 * Deliver notices such as due reminders: first the ones left unconfirmed by an earlier run,
 * then each new one. A notice is confirmed after it was sent, so a crash in between sends it again (at least once).
 * Notices go out one at a time in the order they fired. An event the channel scheduled is handed to `handle` instead of
 * being sent, with the same order, retry and confirmation.
 */
export async function startNotices(service: NoticeService, options: NoticeOptions): Promise<Notices> {
  const { channel, owns, send, handle, waiting } = options;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const handled = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  const deliver = async (notice: Notice): Promise<void> => {
    const fields = { id: notice.id, key: notice.key };
    if (isEvent(notice) && !handle) {
      // Nothing in this channel schedules events, so none should arrive; it stays unconfirmed rather than be lost.
      log.warn(`${channel}.notice.unhandled`, { ...fields, kind: notice.event.kind });
      return;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        if (isEvent(notice)) await handle?.(notice.key, notice.event);
        else await send(notice.key, notice.text);
        await service.ackNotice(notice.id);
        log.info(`${channel}.notice.delivered`, fields);
        return;
      } catch (error) {
        const reason = waiting?.(error);
        if (reason) {
          log.info(`${channel}.notice.waiting`, { ...fields, reason });
          handled.delete(notice.id);
          return;
        }
        const delay = retryDelaysMs[attempt];
        if (delay === undefined) {
          log.error(`${channel}.notice.failed`, fields, error);
          handled.delete(notice.id);
          return;
        }
        await sleep(delay);
      }
    }
  };
  const enqueue = (notice: Notice) => {
    if (handled.has(notice.id) || !owns(notice.key)) return;
    handled.add(notice.id);
    queue = queue.then(() => deliver(notice));
  };

  // Subscribe before listing so a notice that fires in between is not missed; `handled` removes the overlap.
  const unsubscribe = service.onNotice(enqueue);
  for (const notice of await service.notices(owns)) enqueue(notice);
  return {
    stop: unsubscribe,
    retry: async (which) => {
      for (const notice of await service.notices((key) => owns(key) && which(key))) enqueue(notice);
    },
    idle: () => queue,
  };
}
