import { appDoc, checkpoint } from "../app-docs.ts";
import type { Speaker } from "./transcript.ts";

/** An input whose answer the channel has not confirmed delivering yet. */
export type PendingTurn = { key: string; requestId: string; text: string; speaker?: Speaker };

/** Outbox fields a channel never sees: sharing flags, and the submission ID that matches a run's inputs (`shared-tools.ts`). */
export type OutboxItem = PendingTurn & { submission?: number; privileged?: true; shared?: true };

/** Inputs accepted but not yet confirmed delivered, in arrival order; replayed after a restart. */
export const Outbox = appDoc<{ items: OutboxItem[] }>({
  kind: "app.outbox",
  version: 1,
  initial: () => ({ items: [] }),
  // A base once empty, so confirmed turns are not kept.
  checkpoint: checkpoint.whenEmpty(100),
});
