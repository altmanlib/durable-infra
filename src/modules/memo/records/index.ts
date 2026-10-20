// The memo's table in the business database: the only way into it for the rest of core.
import type { Records } from "../../../platform/records/records.ts";
import { MemoEntries, type MemoEntriesOptions } from "./entries.ts";
import { MEMO_MIGRATIONS } from "./migrations.ts";
import type { MemoSchema } from "./schema.ts";

export {
  MAX_MEMO_BODY_CHARS,
  MAX_MEMO_ENTRIES,
  MAX_MEMO_NAME_CHARS,
  type MemoEntries,
  type MemoEntry,
  type MemoRemoveResult,
  type MemoSetResult,
  type MemoSummary,
  normalizeMemoName,
} from "./entries.ts";

/** What the memo tools use of the entries; a test may hand them its own. */
export type MemoStore = Pick<MemoEntries, "list" | "get" | "set" | "remove">;

/** The domain's name in the business database: the prefix of its table. */
export const MEMO_DOMAIN = "memo";

/** Bring the memo's table to its current shape and open it. Throws when it cannot. */
export async function openMemoEntries(records: Pick<Records, "tables">, options: MemoEntriesOptions = {}): Promise<MemoEntries> {
  return new MemoEntries(await records.tables<MemoSchema>(MEMO_DOMAIN, MEMO_MIGRATIONS), options);
}
