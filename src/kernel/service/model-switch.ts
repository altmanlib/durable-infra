import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
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

export const sameModel = (a: ModelRef, b: ModelRef): boolean => a.provider === b.provider && a.modelId === b.modelId;

/** What `AgentService.setModel` came to. */
export type SetModelResult = "saved" | "unchanged" | "unknown_model";

/**
 * Check the models a service is opened with: the catalog holds the default, every entry is known to `models`, and all of
 * them share the default's provider (a conversation moves between models of one gateway; history crossing providers is
 * not supported). Returns the catalog, which is `[model]` when the application gives none. Throws naming the first fault.
 */
export function checkCatalog(models: Models, model: ModelRef, catalog: readonly ModelRef[] = [model]): readonly ModelRef[] {
  if (!catalog.some((entry) => sameModel(entry, model))) throw new Error(`the model catalog does not hold the default model ${modelName(model)}`);
  for (const entry of catalog) {
    if (entry.provider !== model.provider) throw new Error(`the model ${modelName(entry)} is of another provider than the default model ${modelName(model)}`);
    if (!models.getModel(entry.provider, entry.modelId)) throw new Error(`the model ${modelName(entry)} is not known to the models`);
  }
  return catalog;
}

/**
 * Move a conversation to `model`, which the caller has checked against the catalog. Takes effect with the next request the
 * conversation prepares, also when it is running now: a run in flight keeps the model it was prepared with. Returns the
 * model it had (`undefined` when it had none) and whether anything was written; the history is the caller's to note.
 */
export async function selectModel(harness: Harness, id: ConversationId, model: ModelRef): Promise<{ from: ModelRef | undefined; moved: boolean }> {
  const from = (await harness.snapshot(AgentDoc, id, context))?.model;
  if (from && sameModel(from, model)) return { from, moved: false };
  await harness.commit((tx) => configure(tx, id, { model }), context);
  return { from, moved: true };
}

/**
 * Move every conversation whose stored model is not in the catalog (`options.catalog`, by default just `model`) to `model`,
 * all in one commit; that includes forks, subagents and
 * the conversation that owns the scheduled tasks (`core:timers`). Run at open, before work resumes. A conversation on
 * another model of the catalog, chosen with `selectModel`, stays where it is. Durable fixes a
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
  options: { now: () => number; maxChanges: number; changes?: ChangeLog; catalog?: readonly ModelRef[] },
): Promise<number> {
  const allowed = options.catalog ?? [model];
  const moves: { id: ConversationId; from: string }[] = [];
  for await (const id of conversations) {
    const stored = (await harness.snapshot(AgentDoc, id, context))?.model;
    // Unset follows the host's default; the service never creates a conversation like that.
    if (!stored || allowed.some((entry) => sameModel(entry, stored))) continue;
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
