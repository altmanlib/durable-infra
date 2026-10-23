import type { Message } from "@earendil-works/pi-ai";
import { GenerationTask, hook } from "@earendil-works/pi-durable";

import { log } from "../../platform/log.ts";
import type { PromptSource } from "../prompts.ts";

/** Tool rounds one turn may take before the model is asked to wrap up. */
export const DEFAULT_MAX_TOOL_ROUNDS = 10;

/** Tool rounds since the last user message: assistant messages that asked for tools. */
export function toolRoundsThisTurn(messages: readonly Message[]): number {
  let rounds = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") break;
    if (message?.role === "assistant" && message.content.some((part) => part.type === "toolCall")) rounds++;
  }
  return rounds;
}

/** The messages to send: unchanged, or with the notice appended once the budget is used up. */
export function withToolBudget(messages: readonly Message[], maxRounds: number, now: number, notice: string): readonly Message[] | undefined {
  if (toolRoundsThisTurn(messages) < maxRounds) return undefined;
  return [...messages, { role: "user", content: notice, timestamp: now }];
}

/** A soft limit on tool loops: asks the model to answer without stopping it. The notice goes only into that request, at its end, so the cache stays valid. */
export function toolBudgetHook(maxRounds: number, prompts: PromptSource, clock: () => number = Date.now) {
  return hook(GenerationTask, {
    beforeRequest: (request, api) => {
      const messages = withToolBudget(request.messages, maxRounds, clock(), prompts.get("budget.notice"));
      if (!messages) return undefined;
      log.warn("turn.tool_budget_reached", { conversationId: String(api.conversationId), rounds: toolRoundsThisTurn(request.messages), max: maxRounds });
      return { messages };
    },
  });
}
