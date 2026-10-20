/**
 * Tools of a conversation several people share, such as a group (docs/design/2026-10-19-group-chat.md §3.8): which tools
 * it has, who may call the privileged ones, and moving conversations made earlier to the current list.
 *
 * A shared conversation is one whose stored `tools` is a list (`configure` with exact registrations); every other
 * conversation leaves it unset and has every tool but the deferred ones (the memo's, R047), which are for shared
 * conversations only. The list is the shared tools, which everyone may use, and the
 * privileged ones (such as reminders), which only a run whose every input was sent `privileged` may call. The hook
 * cannot read entries or submissions, only documents, so the run's inputs (`pi.live`) are matched to the outbox, whose
 * items of shared conversations carry their submission ID; an input it cannot match, or whose item is not marked
 * privileged, is not privileged.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type ConversationId,
  configure,
  type DocumentReader,
  type Harness,
  hook,
  LiveDoc,
  type RegistrySnapshot,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import { log } from "../../platform/log.ts";
import type { PromptSource } from "../prompts.ts";
import { ConversationKeys } from "./notices.ts";
import { Outbox } from "./outbox.ts";
import type { Speaker } from "./transcript.ts";

const context = BACKGROUND_CONTEXT;

/** Which tools a shared conversation has: `shared` for everyone, `privileged` for privileged inputs only. */
export type SharedToolNames = { shared: readonly string[]; privileged: readonly string[] };

/** The registered tools of a shared conversation, in registry order; a name not installed is left out. */
export function sharedToolsOf(snapshot: RegistrySnapshot, names: SharedToolNames): ToolRegistration[] {
  const wanted = new Set([...names.shared, ...names.privileged]);
  return snapshot
    .tools()
    .map(({ tool }) => tool)
    .filter((tool) => wanted.has(tool.name));
}

/** Whether the conversation is shared: its stored tools are an exact list. */
export async function isShared(read: DocumentReader, conversationId: ConversationId): Promise<boolean> {
  const agent = await read.snapshot(AgentDoc, conversationId, context);
  return Array.isArray(agent?.tools);
}

/** Why a privileged tool may not run now, or `undefined` when it may. */
async function refusal(read: DocumentReader, conversationId: ConversationId): Promise<string | undefined> {
  const inputs = (await read.snapshot(LiveDoc, conversationId, context))?.run?.inputs ?? [];
  if (inputs.length === 0) return "no_input";
  const items = (await read.snapshot(Outbox, context))?.items ?? [];
  // An input whose item is not marked privileged, or not matched yet, was not sent privileged.
  const privileged = new Set(items.filter((item) => item.privileged && item.submission !== undefined).map((item) => item.submission));
  return inputs.every((input) => privileged.has(Number(input))) ? undefined : "not_privileged";
}

/**
 * Who asked in the current run: the speaker of the last of its inputs that the outbox matches (the path the hook
 * takes). Every input of a shared conversation carries its submission there once submitted; a run without one, an
 * input not matched yet, and one without a speaker give `undefined`.
 */
export async function speakerOf(read: DocumentReader, conversationId: ConversationId): Promise<Speaker | undefined> {
  const inputs = (await read.snapshot(LiveDoc, conversationId, context))?.run?.inputs ?? [];
  if (inputs.length === 0) return undefined;
  const items = (await read.snapshot(Outbox, context))?.items ?? [];
  for (const input of [...inputs].reverse()) {
    const item = items.find((candidate) => candidate.submission !== undefined && candidate.submission === Number(input));
    if (item) return item.speaker;
  }
  return undefined;
}

/** Who asked in the current run, as the speaker's id (`speakerOf`). */
export async function askerOf(read: DocumentReader, conversationId: ConversationId): Promise<string | undefined> {
  return (await speakerOf(read, conversationId))?.id;
}

/**
 * Block a privileged tool in a shared conversation unless every input of the current run is privileged; the model is
 * told why (`tool.not-permitted`). Other tools, and every tool of other conversations, are not checked.
 */
export function privilegedToolsHook(privileged: readonly string[], prompts: PromptSource) {
  const names = new Set(privileged);
  return hook(ToolTask, {
    beforeTool: async (call, api) => {
      if (!names.has(call.name)) return undefined;
      if (!(await isShared(api, api.conversationId))) return undefined;
      const reason = await refusal(api, api.conversationId);
      if (reason === undefined) return undefined;
      const key = (await api.snapshot(ConversationKeys, String(api.conversationId), context))?.key;
      log.info("agent.tool_refused", { conversation: key || `#${api.conversationId}`, tool: call.name, reason });
      return { block: prompts.get("tool.not-permitted") };
    },
  });
}

const sameNames = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((name, index) => name === b[index]);

/**
 * What a shared conversation stores of its tools: the list as the enabled tools, and again as the ones offered to the
 * model, so it is offered the deferred ones too. A deferred tool, such as the memo's, is one only shared conversations
 * get: a conversation that has every tool (`modelTools` unset) is not offered it.
 */
export function sharedAgent(tools: readonly ToolRegistration[]): { tools: ToolRegistration[]; modelTools: ToolRegistration[] } {
  return { tools: [...tools], modelTools: [...tools] };
}

/**
 * Give every shared conversation the current list (`sharedAgent`), in one commit, at open before work resumes; a
 * conversation that already has it, offered to the model too, is left alone, so a second open changes nothing. Logs a line per conversation; returns how many moved.
 */
export async function moveToSharedTools(harness: Harness, conversations: AsyncIterable<ConversationId>, tools: readonly ToolRegistration[]): Promise<number> {
  const target = tools.map((tool) => tool.name);
  const moves: { id: ConversationId; from: string[] }[] = [];
  for await (const id of conversations) {
    const agent = await harness.snapshot(AgentDoc, id, context);
    const stored = agent?.tools;
    if (!Array.isArray(stored)) continue;
    const from = [...stored];
    if (sameNames(from, target) && Array.isArray(agent?.modelTools) && sameNames(agent.modelTools, target)) continue;
    moves.push({ id, from });
  }
  if (moves.length === 0) return 0;
  await harness.commit(async (tx) => {
    for (const move of moves) await configure(tx, move.id, sharedAgent(tools));
  }, context);
  for (const move of moves) {
    const key = (await harness.snapshot(ConversationKeys, String(move.id), context))?.key;
    log.info("agent.shared_tools_moved", { conversation: key || `#${move.id}`, from: move.from.join(","), to: target.join(",") });
  }
  return moves.length;
}
