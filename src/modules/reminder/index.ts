import type { Module } from "../../kernel/module.ts";
import { noRemindersSection } from "./no-reminders.ts";
import { REMINDER_PROMPTS } from "./prompts.ts";
import { createCancelReminderTool, createListRemindersTool, createReminderTool, Remind, SET_REMINDER } from "./reminder.ts";

export { REMINDER_PROMPTS } from "./prompts.ts";

/**
 * Reminders: a task that waits for the time and then leaves a notice for the channel to deliver. In a shared
 * conversation they change state, so only a privileged asker may use them.
 */
export function reminderModule(): Module {
  return {
    name: "reminder",
    prompts: REMINDER_PROMPTS,
    privilegedTools: [SET_REMINDER, "list_reminders", "cancel_reminder"],
    contribute: (context) => ({
      tools: [createReminderTool(context), createListRemindersTool(context), createCancelReminderTool(context)],
      sections: [noRemindersSection(context.prompts)],
      tasks: [Remind],
    }),
  };
}
