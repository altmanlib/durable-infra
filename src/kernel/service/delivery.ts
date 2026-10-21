import { log } from "../../platform/log.ts";
import type { AgentService, ConversationKey, OwnsKey } from "./agent-service.ts";
import { TurnFailed } from "./agent-service.ts";
import { isEvent, type Notice, type ScheduledEvent } from "./notices.ts";

/** Delivery shared by all channels: replays unconfirmed answers and notices; a channel supplies its keys, sender and texts. */

/** Sends text to the user behind a key; throws if not sent. Replay passes `requestId` so the answer can be tied to its message. */
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

/** Delivers unconfirmed answers: keys in parallel, one key's inputs in order; a failure holds back that key's later inputs. Returns the count delivered. */
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
  /** Runs when a scheduled event comes due; may run again after a crash, so it must be idempotent. Omit if nothing is scheduled. */
  handle?: (key: ConversationKey, event: ScheduledEvent) => Promise<void>;
  /** A reason when sending to this user is pointless for now, else undefined; such notices wait for `retry` or the next start. */
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

/** Delivers notices such as due reminders, oldest first; confirmed after sending, so a crash may resend one (at least once). Scheduled events go to `handle`. */
export async function startNotices(service: NoticeService, options: NoticeOptions): Promise<Notices> {
  const { channel, owns, send, handle, waiting } = options;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const handled = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  const deliver = async (notice: Notice): Promise<void> => {
    const fields = { id: notice.id, key: notice.key };
    if (isEvent(notice) && !handle) {
      // No `handle` means no scheduled events are expected; keep it unconfirmed.
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
