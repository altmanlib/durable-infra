/** The insights tables' types, as Kysely queries them; the migrations create the tables and must stay in step. */

/** Dated spend of one channel key in one time bucket, by model or tool. */
export type SpendTable = {
  /** The conversation's channel key; empty for a conversation without one (a fork, the timers). */
  key: string;
  /** Start of the bucket in ms since epoch, divided by `BUCKET_MS` and rounded down. */
  bucket: number;
  kind: "model" | "tool";
  name: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
};

/** How far each conversation's entries are counted into `insights_spend`. */
export type CursorTable = {
  conversation_id: number;
  /** Read once, when the conversation was first seen. */
  key: string;
  /** The newest entry already counted; 0 before any. */
  last_entry_id: number;
};

/** The conversation each key points at, for the paged listing. */
export type ConversationTable = {
  key: string;
  conversation_id: number;
  /** Newest message time in ms; null before the first message. */
  last_active_at: number | null;
};

export type InsightsSchema = {
  insights_spend: SpendTable;
  insights_cursor: CursorTable;
  insights_conversation: ConversationTable;
};
