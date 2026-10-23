import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { AgentDoc, configure, type ConversationId, type Harness, type ModelRef } from "@earendil-works/pi-durable";

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

/** Checks the models a service opens with: the catalog holds the default, all known to `models`, all of one provider. Throws naming the first fault. */
export function checkCatalog(models: Models, model: ModelRef, catalog: readonly ModelRef[] = [model]): readonly ModelRef[] {
  if (!catalog.some((entry) => sameModel(entry, model))) throw new Error(`the model catalog does not hold the default model ${modelName(model)}`);
  for (const entry of catalog) {
    if (entry.provider !== model.provider) throw new Error(`the model ${modelName(entry)} is of another provider than the default model ${modelName(model)}`);
    if (!models.getModel(entry.provider, entry.modelId)) throw new Error(`the model ${modelName(entry)} is not known to the models`);
  }
  return catalog;
}

/** Moves a conversation to `model` (checked by the caller) from its next request; returns the previous model and whether anything was written. */
export async function selectModel(harness: Harness, id: ConversationId, model: ModelRef): Promise<{ from: ModelRef | undefined; moved: boolean }> {
  const from = (await harness.snapshot(AgentDoc, id, context))?.model;
  if (from && sameModel(from, model)) return { from, moved: false };
  await harness.commit((tx) => configure(tx, id, { model }), context);
  return { from, moved: true };
}

/** Moves conversations whose model is outside the catalog to `model`, in one commit at open; a second open changes nothing. Returns how many moved. */
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
    // Unset follows the host's default; the service never creates such a conversation.
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
