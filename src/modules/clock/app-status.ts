import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { BaseDeps } from "../../kernel/module.ts";
import { formatLocal } from "../../platform/local-time.ts";

/**
 * Facts about the running application: its version, when it started and for how long it has run
 * (docs/design/2026-10-13-app-status-tool.md). Only facts that are safe to show every user belong here; check §5 of the
 * design before adding one. Read-only, so an interrupted call may simply run again and report the new process.
 */
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
