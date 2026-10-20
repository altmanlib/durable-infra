import { appDoc, checkpoint } from "../app-docs.ts";
import type { Speaker } from "./transcript.ts";

/** An input whose answer the channel has not confirmed delivering yet. */
export type PendingTurn = { key: string; requestId: string; text: string; speaker?: Speaker };

/**
 * What the outbox keeps of an input besides what a channel replays: whether it was sent to a shared conversation, and
 * whether it may use the privileged tools there (`shared-tools.ts`); for those, its submission, set once submitted, so
 * the run's inputs can be matched to their items. Never given to a channel.
 */
export type OutboxItem = PendingTurn & { submission?: number; privileged?: true; shared?: true };

/**
 * Inputs accepted but not yet confirmed delivered, in arrival order. A channel replays them after a restart
 *.
 */
export const Outbox = appDoc<{ items: OutboxItem[] }>({
  kind: "app.outbox",
  version: 1,
  initial: () => ({ items: [] }),
  // Empty again after each answer is confirmed: a base then, so neither the past turns nor their texts are kept.
  checkpoint: checkpoint.whenEmpty(100),
});
