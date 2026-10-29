import type { Context } from "@earendil-works/chord";
import type { ConversationId, DocumentReader } from "@earendil-works/pi-durable";

import { ConversationKeys } from "./notices.ts";

type Snapshots = Pick<DocumentReader, "snapshot">;

/** What `keyOf` reads the key from: a tool's execution api or a hook api, or a prompt section's input (pass it as is). */
export type KeyedApi = ({ conversationId: ConversationId } & Snapshots) | { conversationId: ConversationId; read: Snapshots };

/** The conversation's channel key; `undefined` for a conversation without one (a fork, a child conversation, the timers'). */
export async function keyOf(api: KeyedApi, context: Context): Promise<string | undefined> {
  const reader = "snapshot" in api ? api : api.read;
  return (await reader.snapshot(ConversationKeys, String(api.conversationId), context))?.key || undefined;
}

/** The key for a log line only: never fails the tool, and is `undefined` when it cannot be read. */
export async function keyForLog(api: unknown, context: Context): Promise<string | undefined> {
  try {
    return await keyOf(api as KeyedApi, context);
  } catch {
    return undefined;
  }
}
