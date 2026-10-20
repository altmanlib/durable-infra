import { entry, type PromptEntries } from "../../kernel/prompts.ts";

export const REMINDER_PROMPTS = {
  "system.no-reminders": entry(
    "You cannot set reminders or schedule anything in this conversation. When someone asks for one, say plainly that it cannot be done here and suggest a private chat with you; never promise to remind anyone.",
    "只在提供了工具、但没有 set_reminder 时附上（没给群会话配提醒工具时，R036），免得模型没有提醒工具还答应到点提醒；配了的群会话由 system.shared 说谁能用",
    "next-request",
  ),
  "tool.set_reminder.description": entry(
    "Schedule a reminder message for the user at an exact time. Use current_time first to know the present moment. The text is delivered to the user as written, so write it as the message they should read.",
    "工具 set_reminder 的描述",
    "extension-install",
  ),
  "tool.set_reminder.at": entry(
    "When to remind: the user's local date and time, e.g. 2026-10-05T18:30:00",
    "参数 at 的描述（set_reminder）",
    "extension-install",
  ),
  "tool.set_reminder.text": entry("The reminder message, exactly as the user should see it", "参数 text 的描述（set_reminder）", "extension-install"),
  "tool.list_reminders.description": entry(
    "List this chat's reminders that have not fired yet, soonest first, with the id that cancel_reminder takes.",
    "工具 list_reminders 的描述",
    "extension-install",
  ),
  "tool.cancel_reminder.description": entry(
    "Cancel a reminder of this chat that has not fired yet. Get the id from list_reminders.",
    "工具 cancel_reminder 的描述",
    "extension-install",
  ),
  "tool.cancel_reminder.id": entry("Reminder id from list_reminders", "参数 id 的描述（cancel_reminder）", "extension-install"),
} as const satisfies PromptEntries;
