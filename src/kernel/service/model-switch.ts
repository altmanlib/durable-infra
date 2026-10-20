import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId, configure, type Harness, type ModelRef } from "@earendil-works/pi-durable";
import { log } from "../../platform/log.ts";
import type { ChangeLog } from "../settings/change-log.ts";
import { recordChange } from "../settings/docs.ts";
import { ConversationKeys } from "./notices.ts";

const context = BACKGROUND_CONTEXT;

/** How a model is written in the log and the history, such as `cliproxy/grok-4.5`. */
export function modelName(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

/**
 * Move every conversation whose stored model is not `model` to it, all in one commit; that includes forks, subagents and
 * the conversation that owns the scheduled tasks (`core:timers`). Run at open, before work resumes. Durable fixes a
 * request's model when it prepares the request and keeps it in the generation's checkpoint, so a run an earlier process
 * left unfinished asks the new model from its next prepared request; one already prepared, sent or being polled resumes
 * with the model it was prepared with. A conversation that already has the model is left alone, so a second open
 * changes nothing. The history gets one entry per previous model (`area: "model"`, `target` the number of conversations
 * moved from it), so a switch does not push the console's edits out of it; the log has a line per conversation. With a
 * `ChangeLog` of the application's own the history is noted there after the commit instead. Returns how many were moved.
 */
export async function moveToModel(
  harness: Harness,
  conversations: AsyncIterable<ConversationId>,
  model: ModelRef,
  options: { now: () => number; maxChanges: number; changes?: ChangeLog },
): Promise<number> {
  const moves: { id: ConversationId; from: string }[] = [];
  for await (const id of conversations) {
    const stored = (await harness.snapshot(AgentDoc, id, context))?.model;
    // Unset follows the host's default; the service never creates a conversation like that.
    if (!stored || (stored.provider === model.provider && stored.modelId === model.modelId)) continue;
    moves.push({ id, from: modelName(stored) });
  }
  if (moves.length === 0) return 0;
  const to = modelName(model);
  const counts = Map.groupBy(moves, (move) => move.from);
  const at = options.now();
  await harness.commit(async (tx) => {
    for (const move of moves) await configure(tx, move.id, { model });
    if (options.changes) return;
    for (const [from, moved] of counts) {
      await recordChange(tx, { at, area: "model", target: String(moved.length), before: from, after: to }, options.maxChanges);
    }
  }, context);
  if (options.changes) {
    for (const [from, moved] of counts) {
      try {
        await options.changes.record({ at, area: "model", target: String(moved.length), before: from, after: to });
      } catch (error) {
        log.error("changes.record_failed", { area: "model", target: String(moved.length) }, error);
      }
    }
  }
  for (const move of moves) {
    const key = (await harness.snapshot(ConversationKeys, String(move.id), context))?.key;
    log.info("agent.model_switched", { conversation: key || `#${move.id}`, from: move.from, to });
  }
  return moves.length;
}
