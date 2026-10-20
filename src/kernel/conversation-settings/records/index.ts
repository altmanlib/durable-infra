// The conversation settings' table in the business database: the only way into it for the rest of core.
import type { Records } from "../../../platform/records/records.ts";
import { SETTING_MIGRATIONS } from "./migrations.ts";
import type { SettingSchema } from "./schema.ts";
import { SettingRows, type SettingRowsOptions } from "./store.ts";

export type { SettingRemoveResult, SettingRows, StoredSetting } from "./store.ts";

/** What the settings use of the rows; a test may hand them its own. */
export type SettingStore = Pick<SettingRows, "list" | "read" | "write" | "remove">;

/** What opening the table needs of the business database. */
export type SettingTables = Pick<Records, "tables">;

/** The domain's name in the business database: the prefix of its table. */
export const SETTING_DOMAIN = "conversation";

/** Bring the settings' table to its current shape and open it. Throws when it cannot. */
export async function openSettingStore(records: SettingTables, options: SettingRowsOptions = {}): Promise<SettingRows> {
  return new SettingRows(await records.tables<SettingSchema>(SETTING_DOMAIN, SETTING_MIGRATIONS), options);
}
