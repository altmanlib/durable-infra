import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { BaseDeps } from "../../kernel/module.ts";
import { formatLocal } from "../../platform/local-time.ts";

/** Facts about the running application (version, start time, uptime); only facts safe to show every user belong here. Read-only. */
export function createAppStatusTool(deps: Pick<BaseDeps, "now" | "prompts" | "startedAt" | "version">) {
  return defineTool({
    name: "app_status",
    description: deps.prompts.get("tool.app_status.description"),
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      const uptimeSeconds = Math.max(0, Math.floor((deps.now().getTime() - deps.startedAt.getTime()) / 1000));
      const text = [`Version: ${deps.version}`, `Started: ${formatLocal(deps.startedAt)}`, `Uptime seconds: ${uptimeSeconds}`].join("\n");
      return { output: [{ type: "text", text }], details: { code: "reported" } };
    },
  });
}
