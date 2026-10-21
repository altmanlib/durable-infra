import type { JsonValue } from "@earendil-works/chord";
import { type CheckpointInfo, defineDoc, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";

/** The one way to define the app's own Durable documents (`app.*`), each with a checkpoint: without one, the storage grows without end. */

/** Whether the change about to be stored is stored whole: `value` is the document after it. */
export type Checkpoint<T> = (value: Readonly<T>, info: CheckpointInfo) => boolean;

export const checkpoint = {
  /** Store a full copy every `changes` changes. */
  every:
    <T>(changes: number): Checkpoint<T> =>
    (_value, info) =>
      info.deltasSinceBase + 1 >= changes,
  /** Store a full copy whenever the queue is empty, and every `changes` changes otherwise (such as the outbox). */
  whenEmpty:
    <T extends { items: readonly unknown[] }>(changes: number): Checkpoint<T> =>
    (value, info) =>
      value.items.length === 0 || info.deltasSinceBase + 1 >= changes,
};

/** `migrate` converts a value stored at an older `version` when it is read; without it an older stored version throws. */
type AppDoc<T> = {
  kind: `app.${string}`;
  version: number;
  checkpoint: Checkpoint<T>;
  migrate?: (value: JsonObject, fromVersion: number) => T;
};

/** One document for the whole application (session scope). */
export function appDoc<T extends JsonObject>(definition: AppDoc<T> & { initial: () => T }) {
  const { kind, version, initial, migrate, checkpoint: when } = definition;
  return defineDoc<T>({ kind, version, scope: "session", initial, migrate, checkpointWhen: (value, _ops, info) => when(value, info) });
}

/** A family of documents for the whole application, one per key (session scope). */
export function appDocFamily<T extends JsonObject, I extends JsonValue>(definition: AppDoc<T> & { initial: (seed: I) => T }) {
  const { kind, version, initial, migrate, checkpoint: when } = definition;
  return defineDocFamily<T, I>({
    kind,
    version,
    scope: "session",
    family: true,
    initial,
    migrate,
    checkpointWhen: (value, _ops, info) => when(value, info),
  });
}
