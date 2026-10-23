import { section } from "@earendil-works/pi-durable";

import type { PromptSource } from "../../kernel/prompts.ts";
import { SET_REMINDER } from "./reminder.ts";

/** Said where there are tools but no reminders, so the model does not promise one. */
export const noRemindersSection = (prompts: PromptSource) =>
  section(
    "no-reminders",
    ({ agent }) => (agent.tools.length > 0 && !agent.tools.some((tool) => tool.name === SET_REMINDER) ? prompts.get("system.no-reminders") : undefined),
    { tag: false },
  );
