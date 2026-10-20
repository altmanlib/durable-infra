/**
 * The memo's table in the business database, as Kysely types the queries by. The table itself is made by the
 * migrations (`migrations.ts`); keep the two in step. Nothing outside `core/memo/records` sees these types.
 */

/** One entry of a conversation's memo (docs/design/2026-10-19-group-memo.md §3.1). */
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
