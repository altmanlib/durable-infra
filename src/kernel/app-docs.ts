import type { JsonValue } from "@earendil-works/chord";
import { type CheckpointInfo, defineDoc, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";

/**
 * The one way the application defines its own Durable documents (`app.*`), so none can leave out when to store a
 * full copy (docs/persistence.md §3).
 *
 * Durable stores a document as a full copy (a base) and then each change as a delta; reading it replays every delta
 * since the newest base. A session document drops its older deltas when a new base is stored, and only then: a document
 * without a checkpoint keeps every change it ever had, so the first read after a restart replays its whole history and
 * the storage grows without end (measured on a bot in use: 150,000 turns of the outbox, 1.25 s and 94 MB; with a checkpoint, 1 ms and
 * 0.1 MB). Durable's own documents (`pi.*`) set theirs; ours set it here.
 */

/** Whether the change about to be stored is stored whole: `value` is the document after it. */
export type Checkpoint<T> = (value: Readonly<T>, info: CheckpointInfo) => boolean;

export const checkpoint = {
  /** Store a full copy every `changes` changes: a read replays fewer than that, and the storage keeps no more. */
  every:
    <T>(changes: number): Checkpoint<T> =>
    (_value, info) =>
      info.deltasSinceBase + 1 >= changes,
  /**
   * A queue that is empty most of the time, such as the outbox: store a full copy whenever it is empty, which is right
   * after its last item was taken (an empty base is tiny), and every `changes` changes while it is not.
   */
  whenEmpty:
    <T extends { items: readonly unknown[] }>(changes: number): Checkpoint<T> =>
    (value, info) =>
      value.items.length === 0 || info.deltasSinceBase + 1 >= changes,
};

type AppDoc<T> = { kind: `app.${string}`; version: number; checkpoint: Checkpoint<T> };

/** One document for the whole application (session scope). */
export function appDoc<T extends JsonObject>(definition: AppDoc<T> & { initial: () => T }) {
  const { kind, version, initial, checkpoint: when } = definition;
  return defineDoc<T>({ kind, version, scope: "session", initial, checkpointWhen: (value, _ops, info) => when(value, info) });
}

/** A family of documents for the whole application, one per key (session scope). */
export function appDocFamily<T extends JsonObject, I extends JsonValue>(definition: AppDoc<T> & { initial: (seed: I) => T }) {
  const { kind, version, initial, checkpoint: when } = definition;
  return defineDocFamily<T, I>({ kind, version, scope: "session", family: true, initial, checkpointWhen: (value, _ops, info) => when(value, info) });
}
