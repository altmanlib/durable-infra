/** Per-conversation tool selection: which of its tools a conversation is offered, chosen by the host before each input. */

import type { AgentChange, AgentState, ToolRegistration } from "@earendil-works/pi-durable";

/**
 * The tool names a conversation may use, or `undefined` for no restriction. It only narrows: a tool the conversation would not
 * have anyway (not installed, or a shared-only tool of a one-to-one conversation) is not granted by naming it.
 */
export type AllowedTools = ReadonlySet<string> | readonly string[] | undefined;

/** Chosen by the host from the conversation key; may read a database. */
export type ToolSelector = (key: string) => AllowedTools | Promise<AllowedTools>;

const sameNames = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((name, index) => name === b[index]);

/**
 * The change that makes a conversation offer only `allowed` of the tools it would otherwise offer, or `undefined` when its
 * stored state already says so. A shared conversation (an exact `tools` list) keeps an exact offered list; any other keeps
 * Durable's default offer minus the names left out, and the deferred tools it has loaded stay loaded if allowed.
 */
export function narrowTools(state: Readonly<AgentState> | undefined, registered: readonly ToolRegistration[], allowed: AllowedTools): AgentChange | undefined {
  const names = allowed && new Set(allowed);
  const permits = (name: string) => names === undefined || names.has(name);
  const stored = state?.modelTools;
  const exact = state?.tools;
  if (Array.isArray(exact)) {
    const wanted = registered.filter((tool) => exact.includes(tool.name) && permits(tool.name));
    return Array.isArray(stored) &&
      sameNames(
        stored,
        wanted.map((tool) => tool.name),
      )
      ? undefined
      : { modelTools: wanted };
  }
  const remove = registered.filter((tool) => !permits(tool.name));
  const loaded = Array.isArray(stored) ? [] : (stored?.add ?? []);
  const add = registered.filter((tool) => loaded.includes(tool.name) && permits(tool.name));
  const current = Array.isArray(stored) ? undefined : stored;
  if (remove.length === 0 && add.length === 0) return stored === undefined ? undefined : { modelTools: null };
  const unchanged =
    current &&
    sameNames(
      current.remove ?? [],
      remove.map((tool) => tool.name),
    ) &&
    sameNames(
      current.add ?? [],
      add.map((tool) => tool.name),
    );
  return unchanged ? undefined : { modelTools: { remove, add } };
}
