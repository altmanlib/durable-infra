/** The memo table's types, as Kysely queries them; the migrations create the table and must stay in step. */

/** One entry of a conversation's memo. */
export type EntryTable = {
  /** The conversation's channel key, such as `<channel>:<id>`. */
  conversation_key: string;
  /** Already normalized (`normalizeMemoName`): the same name written with other spacing is the same row. */
  name: string;
  /** Markdown; may be empty. */
  body: string;
  /** ms since epoch. */
  updated_at: number;
  /** Who wrote it last, as the speaker's id; empty when it was not known. */
  updated_by: string;
};

export type MemoSchema = {
  memo_entry: EntryTable;
};
