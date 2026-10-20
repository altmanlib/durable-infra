import type { Module } from "../../kernel/module.ts";
import { SETTINGS_TOOLS_PROMPTS } from "./prompts.ts";
import {
  CLEAR_SETTING,
  createClearSettingTool,
  createListSettingsTool,
  createSetSettingTool,
  LIST_SETTINGS,
  SET_SETTING,
  settingsSection,
} from "./settings.ts";

export { SETTINGS_TOOLS_PROMPTS } from "./prompts.ts";

/**
 * Tools to look at and change the settings of a conversation (the ones other modules register). Everyone in a shared
 * conversation may look; only a privileged asker may change. With no setting registered there are no tools.
 */
export function settingsToolsModule(): Module {
  return {
    name: "settings-tools",
    prompts: SETTINGS_TOOLS_PROMPTS,
    sharedTools: [LIST_SETTINGS],
    privilegedTools: [SET_SETTING, CLEAR_SETTING],
    contribute: (context) => ({
      tools: context.settings.catalog.empty ? [] : [createListSettingsTool(context), createSetSettingTool(context), createClearSettingTool(context)],
      sections: [settingsSection(context.prompts)],
    }),
  };
}
