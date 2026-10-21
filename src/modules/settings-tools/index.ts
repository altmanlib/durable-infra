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

const NEEDS_A_SETTING = "only if a module registers a setting";

/** Tools to view and change a conversation's settings; in a shared conversation only privileged askers may change them. */
export function settingsToolsModule(): Module {
  return {
    name: "settings-tools",
    prompts: SETTINGS_TOOLS_PROMPTS,
    toolSpecs: [
      { name: LIST_SETTINGS, scope: "shared-only", note: NEEDS_A_SETTING },
      { name: SET_SETTING, scope: "shared-only", access: "privileged", note: NEEDS_A_SETTING },
      { name: CLEAR_SETTING, scope: "shared-only", access: "privileged", note: NEEDS_A_SETTING },
    ],
    contribute: (context) => ({
      tools: context.settings.catalog.empty ? [] : [createListSettingsTool(context), createSetSettingTool(context), createClearSettingTool(context)],
      sections: [settingsSection(context.prompts)],
    }),
  };
}
