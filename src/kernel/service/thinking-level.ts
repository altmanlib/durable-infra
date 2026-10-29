import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, configure, type ConversationId, type Harness } from "@earendil-works/pi-durable";

import { log } from "../../platform/log.ts";
import { ConversationKeys } from "./notices.ts";

const context = BACKGROUND_CONTEXT;

/** The thinking level of a service that is not given one; new conversations store it. */
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "low";

/** Moves every conversation whose stored thinking level differs from `level` to it, in one commit at open; a second open changes nothing. Returns how many moved. */
export async function moveToThinkingLevel(harness: Harness, conversations: AsyncIterable<ConversationId>, level: ModelThinkingLevel): Promise<number> {
  const moves: { id: ConversationId; from: ModelThinkingLevel }[] = [];
  for await (const id of conversations) {
    const stored = (await harness.snapshot(AgentDoc, id, context))?.thinkingLevel;
    // Unset follows the host's default; the service never creates such a conversation.
    if (!stored || stored === level) continue;
    moves.push({ id, from: stored });
  }
  if (moves.length === 0) return 0;
  await harness.commit(async (tx) => {
    for (const move of moves) await configure(tx, move.id, { thinkingLevel: level });
  }, context);
  for (const move of moves) {
    const key = (await harness.snapshot(ConversationKeys, String(move.id), context))?.key;
    log.info("agent.thinking_level_switched", { conversation: key || `#${move.id}`, from: move.from, to: level });
  }
  return moves.length;
}
