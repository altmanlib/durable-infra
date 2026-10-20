import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { BaseDeps } from "../../kernel/module.ts";
import { formatLocal } from "../../platform/local-time.ts";

/**
 * Exact current time, as local time. The system prompt only carries the date, at day granularity, to keep the provider cache warm.
 * Read-only, so an interrupted call may simply run again.
 */
export function createClockTool(deps: Pick<BaseDeps, "now" | "prompts">) {
  return defineTool({
    name: "current_time",
    description: deps.prompts.get("tool.current_time.description"),
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      return { output: [{ type: "text", text: formatLocal(deps.now()) }] };
    },
  });
}
