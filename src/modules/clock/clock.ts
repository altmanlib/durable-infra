import { defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";

import type { BaseDeps } from "../../kernel/module.ts";
import { formatLocal } from "../../platform/local-time.ts";

/** Exact local time; the system prompt carries only the date, so the provider's prompt cache stays warm. Read-only. */
export function createClockTool(deps: Pick<BaseDeps, "now" | "prompts">) {
  return defineTool({
    name: "current_time",
    description: deps.prompts.get("tool.current_time.description"),
    parameters: obj({}, { open: true }),
    replay: "safe",
    execute: async () => {
      return { output: [{ type: "text", text: formatLocal(deps.now()) }] };
    },
  });
}
