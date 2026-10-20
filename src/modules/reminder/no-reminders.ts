import { section } from "@earendil-works/pi-durable";
import type { PromptSource } from "../../kernel/prompts.ts";
import { SET_REMINDER } from "./reminder.ts";

/**
 * Said where there are tools but no reminders, such as in a group (R036): without it the model promises a reminder it
 * cannot set. Not with no tools at all, where `no-tools` already says so.
 */
export const noRemindersSection = (prompts: PromptSource) =>
  section(
    "no-reminders",
    ({ agent }) => (agent.tools.length > 0 && !agent.tools.some((tool) => tool.name === SET_REMINDER) ? prompts.get("system.no-reminders") : undefined),
    { tag: false },
  );
