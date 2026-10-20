// The settings of a conversation, such as a group: the one door for the rest of
// core, both for the tools and for the modules that register and read a setting.
import { SettingCatalog } from "./catalog.ts";
import { openSettingStore, type SettingTables } from "./records/index.ts";
import { ConversationSettings, type ConversationSettingsOptions } from "./settings.ts";
import type { SettingSpec } from "./spec.ts";

export { SettingCatalog } from "./catalog.ts";
export type { SettingStore, StoredSetting } from "./records/index.ts";
export {
  ConversationSettings,
  type ConversationSettingsOptions,
  type SettingClearResult,
  type SettingSetResult,
  type SettingView,
} from "./settings.ts";
export {
  CHECK_TIMEOUT_MS,
  DEFAULT_SETTING_CHARS,
  MAX_SETTING_CHARS,
  MAX_SETTING_NAME_CHARS,
  maxCharsOf,
  SETTING_NAME,
  type SettingCheck,
  type SettingCheckContext,
  type SettingSpec,
} from "./spec.ts";

/** Open the settings' table and put the registered settings over it. Throws when the table cannot be opened or a setting is registered wrongly. */
export async function openConversationSettings(
  records: SettingTables,
  specs: readonly SettingSpec<unknown>[],
  options: ConversationSettingsOptions & { now?: () => number } = {},
): Promise<ConversationSettings> {
  const catalog = new SettingCatalog(specs);
  const store = await openSettingStore(records, options.now ? { now: options.now } : {});
  return new ConversationSettings(catalog, store, options);
}
