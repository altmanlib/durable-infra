import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTask, defineTool, type TaskId, type ToolExecutionApi } from "@earendil-works/pi-durable";

import type { BaseDeps } from "../../kernel/module.ts";
import { ConversationKeys, Notices } from "../../kernel/service/notices.ts";
import { formatLocal, parseLocal } from "../../platform/local-time.ts";
import { log } from "../../platform/log.ts";

export const SET_REMINDER = "set_reminder";

/** Most reminders one conversation may have waiting; bounds what a single chat can pile up. */
export const MAX_PENDING_REMINDERS = 20;

const REMIND_TASK = "core.reminder";

type RemindInput = { key: string; text: string; at: number };

/** Sleeps until `at`, then records the notice and finishes in one commit, so a reminder fires exactly once across restarts. */
export const Remind = defineTask<RemindInput, { phase: "wait" } | { phase: "fire" }, string>({
  name: REMIND_TASK,
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      await runtime.sleepUntil(task.input.at, { phase: "fire" }, context);
    },
    fire: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        (await tx.doc(Notices)).items.push({
          id: String(runtime.taskId),
          key: task.input.key,
          text: task.input.text,
          dueAt: task.input.at,
        });
        return { status: "terminal", outcome: { status: "completed", result: "fired" } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

const coded = (code: string, message: string) => ({ output: [{ type: "text" as const, text: message }], details: { code } });
const error = (code: string, message: string) => ({ isError: true as const, ...coded(code, message) });

type Live = { id: TaskId; at: number; text: string };

/** The conversation's reminders that have not fired or been cancelled, soonest first. */
async function liveReminders(api: { conversationId: ConversationId; commit: ToolExecutionApi["commit"] }, context: Context): Promise<Live[]> {
  const found = await api.commit(async (tx) => {
    const records: Live[] = [];
    for (const status of ["pending", "running", "waiting", "sleeping"] as const) {
      const page = await tx.scanTasks({ conversationId: api.conversationId, kind: REMIND_TASK, status }, MAX_PENDING_REMINDERS + 1);
      for (const record of page.items) {
        if (record.abortRequested) continue;
        const input = record.input as RemindInput;
        records.push({ id: record.id as TaskId, at: input.at, text: input.text });
      }
    }
    return records;
  }, context);
  return found.sort((a, b) => a.at - b.at);
}

export function createReminderTool(deps: Pick<BaseDeps, "now" | "prompts">) {
  return defineTool({
    name: SET_REMINDER,
    description: deps.prompts.get("tool.set_reminder.description"),
    parameters: Type.Object({
      at: Type.String({ description: deps.prompts.get("tool.set_reminder.at") }),
      text: Type.String({ minLength: 1, description: deps.prompts.get("tool.set_reminder.text") }),
    }),
    // Running twice would schedule twice; an interrupted call is reported to the model instead.
    replay: "unsafe",
    // The pending-reminder limit is checked before creating, so calls of one round must not interleave.
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const at = parseLocal(args.at);
      if (at === undefined) return error("invalid_at", `"at" is a local date and time, such as 2026-10-05T18:30:00.`);
      if (at <= deps.now().getTime()) return error("not_future", "That time is not in the future. Check current_time and try again.");
      const owner = await api.snapshot(ConversationKeys, String(api.conversationId), context);
      if (!owner?.key) return error("no_conversation", "Reminders are not available in this conversation.");

      const waiting = await liveReminders(api, context);
      if (waiting.length >= MAX_PENDING_REMINDERS) return error("limit", `Too many reminders are waiting (limit ${MAX_PENDING_REMINDERS}).`);

      await api.createTask(Remind, { key: owner.key, text: args.text, at }, { ownership: { kind: "conversation" }, background: true }, context);
      log.info("reminder.set", { key: owner.key, at: new Date(at).toISOString(), waiting: waiting.length + 1 });
      return coded("set", `Reminder set for ${formatLocal(new Date(at))}.`);
    },
  });
}

export function createListRemindersTool(deps: Pick<BaseDeps, "prompts">) {
  return defineTool({
    name: "list_reminders",
    description: deps.prompts.get("tool.list_reminders.description"),
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const live = await liveReminders(api, context);
      const text =
        live.length === 0 ? "No reminders are waiting." : live.map((item) => `${item.id}: ${formatLocal(new Date(item.at))} — ${item.text}`).join("\n");
      return coded("listed", text);
    },
  });
}

export function createCancelReminderTool(deps: Pick<BaseDeps, "abortTask" | "prompts">) {
  return defineTool({
    name: "cancel_reminder",
    description: deps.prompts.get("tool.cancel_reminder.description"),
    parameters: Type.Object({ id: Type.String({ description: deps.prompts.get("tool.cancel_reminder.id") }) }),
    // Cancelling twice is harmless: the second finds nothing to cancel.
    replay: "safe",
    execute: async (args, api, context) => {
      const target = (await liveReminders(api, context)).find((item) => String(item.id) === args.id.trim());
      if (target === undefined) return error("not_found", `No waiting reminder has id ${args.id}. It may have fired or been cancelled already.`);
      const outcome = await deps.abortTask(target.id);
      if (outcome === "terminal") return error("just_fired", "That reminder has just fired and can no longer be cancelled.");
      log.info("reminder.cancelled", { id: String(target.id) });
      return coded("cancelled", `Cancelled the reminder "${target.text}".`);
    },
  });
}
