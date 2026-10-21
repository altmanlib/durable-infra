import { defineTask } from "@earendil-works/pi-durable";
import { Notices, type ScheduledEvent } from "./notices.ts";

/** The conversation that owns every scheduled task: a task needs an owner, and a group should not get a conversation just for a timer. */
export const TIMERS_KEY = "core:timers";

/** The name of the task; what `getTask` reports as its `kind`. */
export const TIMER_TASK = "core.timer";

/** Longest `kind` and `data` of an event; a notice waits in one document until the channel confirms it. */
export const MAX_EVENT_KIND_CHARS = 64;
export const MAX_EVENT_DATA_CHARS = 2000;

export type TimerInput = { key: string; event: ScheduledEvent; at: number };

/** Sleeps until `at`, then records the notice and finishes in one commit, so an event fires exactly once across restarts. */
export const Timer = defineTask<TimerInput, { phase: "wait" }, string>({
  name: TIMER_TASK,
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      await runtime.sleep(task.input.at, context);
      await runtime.commit(async (tx) => {
        (await tx.doc(Notices)).items.push({ id: String(runtime.taskId), key: task.input.key, event: task.input.event, dueAt: task.input.at });
        return { status: "terminal", outcome: { status: "completed", result: "fired" } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
