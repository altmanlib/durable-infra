import type { Context } from "@earendil-works/chord";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { ConversationKeys } from "./notices.ts";

/** What a tool reads of its session to find the conversation's channel key. */
export type KeyedApi = { conversationId: ConversationId; snapshot: ToolExecutionApi["snapshot"] };

/** The conversation's channel key, such as the memo's and the settings' key; `undefined` for a conversation without one. */
export async function keyOf(api: KeyedApi, context: Context): Promise<string | undefined> {
  return (await api.snapshot(ConversationKeys, String(api.conversationId), context))?.key || undefined;
}

/** The key for a log line only: never fails the tool, and is `undefined` when it cannot be read. */
export async function keyForLog(api: unknown, context: Context): Promise<string | undefined> {
  try {
    return await keyOf(api as KeyedApi, context);
  } catch {
    return undefined;
  }
}
