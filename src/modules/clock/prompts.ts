import { entry, type PromptEntries } from "../../kernel/prompts.ts";

export const CLOCK_PROMPTS = {
  "tool.current_time.description": entry(
    "Get the exact current local date and time of the system, which is the time the user lives by. When the user asks about the time zone, answer with this time and say the time zone is unclear.",
    "工具 current_time 的描述",
    "extension-install",
  ),
  "tool.app_status.description": entry(
    "Report facts about this application itself: its version, when it started and how long it has been running, with times as the system's local time. Use it when the user asks when the system or bot started, how long it has been up, or which version it is. For the current time, use current_time.",
    "工具 app_status 的描述",
    "extension-install",
  ),
} as const satisfies PromptEntries;
