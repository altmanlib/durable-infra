import type { Module } from "../../kernel/module.ts";
import { createAppStatusTool } from "./app-status.ts";
import { createClockTool } from "./clock.ts";
import { CLOCK_PROMPTS } from "./prompts.ts";

export { CLOCK_PROMPTS } from "./prompts.ts";

/** `current_time` and `app_status`: facts every user may ask for, so they are open to shared conversations too. */
export function clockModule(): Module {
  return {
    name: "clock",
    prompts: CLOCK_PROMPTS,
    toolSpecs: [{ name: "current_time" }, { name: "app_status" }],
    contribute: (context) => ({ tools: [createClockTool(context), createAppStatusTool(context)] }),
  };
}
