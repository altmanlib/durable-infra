import { appDoc, checkpoint } from "../app-docs.ts";
import type { Change } from "./change-log.ts";

export type { Change } from "./change-log.ts";

/**
 * Edited prompt texts by catalog id, with a counter per id that every write moves forward (a reset too), so a console
 * that read an older state is refused instead of overwriting. Only edited ids appear in `edits`.
 */
export const PromptEdits = appDoc<{ edits: Record<string, string>; versions: Record<string, number> }>({
  kind: "app.prompts",
  version: 1,
  initial: () => ({ edits: {}, versions: {} }),
  checkpoint: checkpoint.every(50),
});

/**
 * Who may talk to each channel, by channel name, as the channel knows its users (such as an open_id), with
 * a counter per channel like the prompts have.
 */
export const AllowlistDoc = appDoc<{ channels: Record<string, string[]>; versions: Record<string, number> }>({
  kind: "app.allowlist",
  version: 1,
  initial: () => ({ channels: {}, versions: {} }),
  checkpoint: checkpoint.every(50),
});

/** What was changed, oldest first, newest last; the oldest are dropped past the cap. */
export const Changes = appDoc<{ items: Change[] }>({
  kind: "app.changes",
  version: 1,
  initial: () => ({ items: [] }),
  checkpoint: checkpoint.every(50),
});

/** History kept; enough for a person's edits for a long time, and the document stays small. */
export const MAX_CHANGES = 500;

/** Add a change to the history inside the commit that makes it, so neither exists without the other. */
export async function recordChange(
  tx: { doc: (definition: typeof Changes) => Promise<{ items: Change[] }> },
  change: Omit<Change, "seq">,
  maxChanges: number,
): Promise<void> {
  const history = await tx.doc(Changes);
  const seq = (history.items.at(-1)?.seq ?? 0) + 1;
  history.items.push({ seq, ...change });
  if (history.items.length > maxChanges) history.items.splice(0, history.items.length - maxChanges);
}
