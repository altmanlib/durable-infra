import { Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import type { ConversationSettings } from "../../kernel/conversation-settings/index.ts";
import type { PromptSource } from "../../kernel/prompts.ts";
import { keyOf } from "../../kernel/service/conversation-key.ts";
import { askerOf } from "../../kernel/service/shared-tools.ts";
import { formatLocal } from "../../platform/local-time.ts";
import { log } from "../../platform/log.ts";

/**
 * The settings of a group: everyone may look, only the privileged may
 * change them (`set_setting` and `clear_setting` are privileged tools). Deferred, like the memo's, so only shared
 * conversations are offered them; installed only when some setting is registered.
 */
export const LIST_SETTINGS = "list_settings";
export const SET_SETTING = "set_setting";
export const CLEAR_SETTING = "clear_setting";
export const SETTINGS_TOOLS = [LIST_SETTINGS, SET_SETTING, CLEAR_SETTING] as const;

const coded = (code: string, message: string) => ({ output: [{ type: "text" as const, text: message }], details: { code } });
const error = (code: string, message: string) => ({ isError: true as const, ...coded(code, message) });

const noConversation = () => error("no_conversation", "This conversation has no settings.");
const failed = (doing: string) => error("failed", `The setting could not be ${doing}: storage failed. Tell the user plainly; do not say it was done.`);
const unknown = (name: string) => error("unknown_setting", `There is no setting named "${name.trim()}". Use list_settings to see the names.`);

type Deps = { settings: ConversationSettings; prompts: PromptSource };

/** How much of a value a log line keeps; settings hold no secrets (§10), so the value itself is logged. */
const LOG_VALUE_CHARS = 80;

const shown = (value: string | undefined) => value?.slice(0, LOG_VALUE_CHARS);

/** What the setting is now, for the log line of its change; `undefined` when not set or unreadable: a log never fails a change. */
async function currentValue(settings: ConversationSettings, key: string, name: string): Promise<string | undefined> {
  try {
    return (await settings.list(key)).find((view) => view.spec.name === name)?.value;
  } catch {
    return undefined;
  }
}

export function createListSettingsTool(deps: Deps) {
  return defineTool({
    name: LIST_SETTINGS,
    description: deps.prompts.get("tool.list_settings.description"),
    parameters: Type.Object({}),
    deferred: true,
    replay: "safe",
    execute: async (_args, api, context) => {
      const key = await keyOf(api, context);
      if (key === undefined) return noConversation();
      let views: Awaited<ReturnType<ConversationSettings["list"]>>;
      try {
        views = await deps.settings.list(key);
      } catch (cause) {
        log.error("setting.failed", { key, name: "", action: "list" }, cause);
        return failed("read");
      }
      // Who changed a setting is kept, not shown (§5).
      const lines = views.map(({ spec, value, updatedAt }) =>
        [
          `- ${spec.name}: ${spec.summary}`,
          `  Format: ${spec.format}`,
          value === undefined ? `  Value: ${spec.unset ?? "not set"}` : `  Value: ${value} (set ${formatLocal(new Date(updatedAt ?? 0))})`,
        ].join("\n"),
      );
      return coded("listed", [`The settings of this conversation (${views.length}):`, ...lines].join("\n"));
    },
  });
}

export function createSetSettingTool(deps: Deps) {
  return defineTool({
    name: SET_SETTING,
    description: deps.prompts.get("tool.set_setting.description"),
    parameters: Type.Object({
      name: Type.String({ description: deps.prompts.get("tool.set_setting.name") }),
      value: Type.String({ description: deps.prompts.get("tool.set_setting.value") }),
    }),
    deferred: true,
    // The check only reads, and writing the same value again leaves the same row: an interrupted call may run again.
    replay: "safe",
    execute: async (args, api, context) => {
      const key = await keyOf(api, context);
      if (key === undefined) return noConversation();
      const name = args.name.trim();
      let outcome: Awaited<ReturnType<ConversationSettings["set"]>>;
      let by = "";
      let previous: string | undefined;
      try {
        // Only a privileged asker gets here (the hook), and theirs is the input the outbox matches (§6.2).
        by = (await askerOf(api, api.conversationId)) ?? "";
        previous = await currentValue(deps.settings, key, name);
        outcome = await deps.settings.set(key, name, args.value, by);
      } catch (cause) {
        log.error("setting.failed", { key, name, action: "set", by }, cause);
        return failed("saved");
      }
      switch (outcome.result) {
        case "saved":
          log.info("setting.saved", { key, name, value: shown(outcome.value), previous: shown(previous), by, checkMs: outcome.checkMs });
          return coded("saved", `Set ${name} to "${outcome.value}".`);
        case "unknown_setting":
          return unknown(name);
        case "invalid_value":
        case "rejected":
          log.info("setting.rejected", { key, name, code: outcome.result, reason: outcome.reason, by });
          return error(outcome.result, `${name} was not set: ${outcome.reason}`);
        case "check_failed":
          log.warn("setting.check_failed", { key, name, ms: outcome.ms, by }, outcome.cause);
          return error("check_failed", `${name} could not be checked just now, so it was not set. Tell the user plainly; they may try again later.`);
      }
    },
  });
}

export function createClearSettingTool(deps: Deps) {
  return defineTool({
    name: CLEAR_SETTING,
    description: deps.prompts.get("tool.clear_setting.description"),
    parameters: Type.Object({ name: Type.String({ description: deps.prompts.get("tool.clear_setting.name") }) }),
    deferred: true,
    // Clearing twice is harmless: the second finds nothing.
    replay: "safe",
    execute: async (args, api, context) => {
      const key = await keyOf(api, context);
      if (key === undefined) return noConversation();
      const name = args.name.trim();
      let result: Awaited<ReturnType<ConversationSettings["clear"]>>;
      let by = "";
      let previous: string | undefined;
      try {
        by = (await askerOf(api, api.conversationId)) ?? "";
        previous = await currentValue(deps.settings, key, name);
        result = await deps.settings.clear(key, name);
      } catch (cause) {
        log.error("setting.failed", { key, name, action: "clear", by }, cause);
        return failed("cleared");
      }
      if (result === "unknown_setting") return unknown(name);
      if (result === "missing") return coded("missing", `${name} was not set; nothing to clear.`);
      log.info("setting.cleared", { key, name, previous: shown(previous), by });
      return coded("cleared", `Cleared ${name}; it is not set now.`);
    },
  });
}

/**
 * Said where the conversation has the settings tools: what they are for, that only certain people may change them, and
 * that a setting is configuration, not an instruction (§7). Not where there is no setting, since then there are no tools.
 */
export const settingsSection = (prompts: PromptSource) =>
  section("settings", ({ agent }) => (agent.tools.some((tool) => tool.name === LIST_SETTINGS) ? prompts.get("system.settings") : undefined), {
    tag: false,
  });
