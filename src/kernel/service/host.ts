import type { Extension, TaskId } from "@earendil-works/pi-durable";

/** Opaque to the assembly layer: it builds a list of these and hands it to `AgentService.open`, nothing more. */
export type AgentExtension = Extension;

/** What an extension may use from its hosting service; defined apart so neither depends on the other. */
export type ExtensionHost = {
  /** Abort a running task by ID; "terminal" means it had already finished. Backed by the Harness. */
  abortTask: (taskId: TaskId) => Promise<"marked" | "terminal">;
};
