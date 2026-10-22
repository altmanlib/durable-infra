// Probes the Durable APIs the bots rely on, against a faux model; run `bun run probe` after each Durable upgrade.
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  AssistantEntry,
  CompactionEntry,
  ConversationBusy,
  type ConversationId,
  type Cursor,
  configure,
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  InboxDoc,
  LiveDoc,
  ResetEntry,
  type Storage,
  UserEntry,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function text(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

// Session-scoped keyed document: channel key -> conversation id.
const ChannelMap = defineDocFamily<{ conversationId: number }, number>({
  kind: "probe.channel",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (conversationId) => ({ conversationId }),
});

const longAnswer = `${"word ".repeat(120)}end`;
const faux = fauxProvider({ models: [{ id: "probe", contextWindow: 100_000, maxTokens: 1000 }], tokensPerSecond: 400 });
faux.setResponses(
  Array.from({ length: 50 }, () => (transcript) => {
    const first = transcript.messages[0];
    if (first?.role === "system" && typeof first.content === "string" && first.content.includes("summarization")) {
      return fauxAssistantMessage("## Summary\nprobe summary");
    }
    return fauxAssistantMessage(longAnswer);
  }),
);
const models = createModels();
models.setProvider(faux.provider);
const agent = { model: { provider: "faux", modelId: "probe" } };

const dir = mkdtempSync(join(tmpdir(), "durable-probe-"));
const dbPath = join(dir, "probe.sqlite");
// Small keepRecentTokens so a manual compaction has something to summarize.
const settings = { compaction: { keepRecentTokens: 50 } };
const open = async () => Harness.open(await openNodeSqliteStorage(dbPath), { models, registry: createRegistry(), settings }, context);

try {
  // 1. createConversation + session doc family mapping in one commit, then reopen.
  let harness = await open();
  const created = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent,
      init: async (tx, id) => {
        await tx.doc(ChannelMap, "chan:42", id);
      },
    },
    context,
  );
  await harness.close(context);
  harness = await open();
  const mapped = await harness.snapshot(ChannelMap, "chan:42", context);
  check("session doc family persists mapping across reopen", mapped?.conversationId === created.id);
  const missing = await harness.snapshot(ChannelMap, "chan:none", context);
  check("snapshot of absent family member is undefined", missing === undefined);
  const conversation = await harness.conversation(mapped?.conversationId as ConversationId, context);
  check("harness.conversation(id) reacquires after reopen", conversation?.id === created.id);
  if (!conversation) throw new Error("conversation missing");

  // 2. Streaming sources: LiveDoc partial (cumulative) and watchEvents text_delta (incremental).
  const partials: string[] = [];
  const view = await conversation.viewState(context);
  const unsubscribe = view.subscribe((value) => {
    const live = value.docs[LiveDoc.definition.kind] as { generation?: { message?: AssistantMessage } } | undefined;
    const partial = text(live?.generation?.message);
    if (partial && partial !== partials.at(-1)) partials.push(partial);
  });
  const stream = await watchEvents(harness, conversation.id, context);
  let deltas = "";
  let endedWith = "";
  stream.start(async (events) => {
    for (const event of events) {
      if (event.type === "message_end" && AssistantEntry.is(event.entry)) {
        endedWith = text(event.entry.model?.[0] as AssistantMessage | undefined);
      }
      // The first committed partial arrives whole in message_start; later commits arrive as deltas.
      if (event.type === "message_start" && event.message.role === "assistant") deltas = text(event.message);
      if (event.type !== "message_update") continue;
      for (const change of event.changes) if (change.type === "text_delta") deltas += change.delta;
    }
  });

  const first = await conversation.submit({ type: "input", content: "hello", requestId: "tg:42:1" }, context);
  const settled = await first.wait(context);
  await harness.waitForIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await stream.stop();
  unsubscribe();
  view.dispose();
  check("submission settles done with answer entry id", settled.status === "done" && settled.answer !== undefined);
  const answerId = settled.answer;
  const answer = answerId !== undefined ? await conversation.commit((tx) => tx.entry(AssistantEntry, answerId), context) : undefined;
  const finalText = text(answer?.model?.[0] as AssistantMessage | undefined);
  check("answer text read via tx.entry(AssistantEntry, id)", finalText === longAnswer);
  check("LiveDoc partial observed more than once", partials.length > 1, `${partials.length} partials`);
  check(
    "LiveDoc partial is cumulative (each is a prefix of the next)",
    partials.every((p, i) => i === 0 || p.startsWith(partials[i - 1] as string)),
  );
  check("last LiveDoc partial is a strict prefix of the final text", finalText.startsWith(partials.at(-1) ?? ""));
  check("watchEvents message_start text + text_delta is a prefix of the final text", finalText.startsWith(deltas));
  check("watchEvents message_end carries the final text", endedWith === finalText, `deltas ${deltas.length}/${finalText.length}`);

  // 3. requestId idempotency, scoped to the conversation.
  const again = await conversation.submit({ type: "input", content: "hello", requestId: "tg:42:1" }, context);
  check("same requestId returns the same submission", again.id === first.id);

  // 3b. Input content as text parts (the speaker tag, then the text) is stored as given, parts and order intact.
  const parts = [
    { type: "text" as const, text: '<speaker id="42"/>' },
    { type: "text" as const, text: "from a group" },
  ];
  await (await conversation.submit({ type: "input", content: parts, requestId: "tg:-100:1" }, context)).wait(context);
  const recent = await conversation.entries({}, 5, undefined, context);
  const stored = recent.items.find((entry) => UserEntry.is(entry))?.model?.[0];
  check("input given as text parts is stored as the same parts", JSON.stringify(stored?.content) === JSON.stringify(parts));

  // 4. Busy: input queues in pi.inbox; whenBusy reject throws ConversationBusy.
  const running = await conversation.submit({ type: "input", content: "second", requestId: "tg:42:2" }, context);
  const queued = await conversation.submit({ type: "input", content: "third", requestId: "tg:42:3" }, context);
  const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
  check("input while busy is queued in pi.inbox", inbox?.items.some((item) => item.id === queued.id) === true);
  let rejected = false;
  try {
    await conversation.submit({ type: "input", content: "nope", whenBusy: "reject" }, context);
  } catch (error) {
    rejected = error instanceof ConversationBusy;
  }
  check("whenBusy reject throws ConversationBusy", rejected);
  await running.wait(context);
  const queuedSettled = await queued.wait(context);
  check("queued follow-up is answered afterwards", queuedSettled.status === "done");

  // 5. reset: resolves on admission; active context restarts, storage keeps old entries.
  await conversation.reset("handoff note", context);
  await conversation.waitForIdle(context);
  const afterReset = await conversation.context(context);
  check("reset head is a pi.reset entry", ResetEntry.is(afterReset.head));
  check(
    "active context after reset excludes earlier answers",
    !afterReset.entries.some((entry) => AssistantEntry.is(entry)),
    `${afterReset.entries.length} active entries`,
  );
  const page = await conversation.entries({}, 100, undefined, context);
  check("entries() still lists pre-reset history", page.items.filter((entry) => AssistantEntry.is(entry)).length >= 3);

  // 6. compact: returns a task id; outcome carries the summary write submission.
  for (const n of [4, 5, 6]) {
    await (await conversation.submit({ type: "input", content: `q${n}` }, context)).wait(context);
  }
  const taskId = await conversation.compact("keep names", context);
  const done = await harness.waitForTask(taskId, context);
  const outcome = done.state.outcome;
  check("manual compaction task completes", outcome.status === "completed", outcome.status);
  if (outcome.status === "completed" && outcome.result.submissionId !== undefined) {
    const placed = await (await harness.submission(outcome.result.submissionId, context))?.wait(context);
    check("compaction summary write is placed", placed?.status === "done", placed?.status);
  } else {
    check("compaction produced a summary submission", false, JSON.stringify(outcome));
  }
  const afterCompact = await conversation.context(context);
  check("compaction entry heads the active context", CompactionEntry.is(afterCompact.head));

  // 7. An interrupted call reruns only when declared `replay: "safe"`; otherwise the model gets an `interrupted` error.
  for (const replay of ["safe", "unsafe"] as const) {
    const toolName = `probe_${replay}`;
    let executions = 0;
    let hangFirst = true;
    const probeTool = defineTool({
      name: toolName,
      description: "Probe tool",
      parameters: Type.Object({}),
      replay,
      execute: async (_args, _api, toolContext) => {
        executions++;
        // The first attempt never finishes on its own; closing the harness plays the crash.
        if (hangFirst) await awaitWithContext(new Promise<never>(() => {}), toolContext);
        return { output: [{ type: "text", text: "tool ran" }] };
      },
    });
    const toolRegistry = () => {
      const registry = createRegistry();
      registry.install(defineExtension({ name: `probe-${replay}`, tools: [probeTool] }));
      return registry;
    };
    const toolDb = join(dir, `tool-${replay}.sqlite`);
    const openTools = async () => Harness.open(await openNodeSqliteStorage(toolDb), { models, registry: toolRegistry(), settings }, context);
    faux.setResponses([() => fauxAssistantMessage(fauxToolCall(toolName, {}), { stopReason: "toolUse" }), () => fauxAssistantMessage("done after tool")]);
    let toolHarness = await openTools();
    const toolConversation = await toolHarness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    await toolConversation.submit({ type: "input", content: "use the tool" }, context);
    while (executions === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await toolHarness.close(context);
    hangFirst = false;
    toolHarness = await openTools();
    toolHarness.resume();
    const reopened = await toolHarness.conversation(toolConversation.id, context);
    await reopened?.waitForIdle(context);
    const entries = await reopened?.entries({}, 100, undefined, context);
    const result = entries?.items.find((entry) => (entry.model?.[0] as { role?: string } | undefined)?.role === "toolResult");
    const resultMessage = result?.model?.[0] as { isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
    const resultText = resultMessage?.content?.map((part) => part.text ?? "").join("") ?? "";
    if (replay === "safe") {
      check("replay safe: interrupted tool reruns after reopen", executions === 2 && resultText.includes("tool ran"), `executions=${executions}`);
    } else {
      check(
        "replay unsafe: interrupted tool is not rerun, model sees an interrupted error",
        executions === 1 && resultMessage?.isError === true && resultText.includes("interrupted"),
        `executions=${executions} text=${resultText}`,
      );
    }
    await toolHarness.close(context);
  }

  // 7b. A tool result's `details` are stored but not sent to the model.
  {
    const coded = defineTool({
      name: "probe_coded",
      description: "Probe tool that reports a code",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => ({ output: [{ type: "text", text: "plain words" }], details: { code: "probe_code_xyz" } }),
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "probe-coded", tools: [coded] }));
    const codedHarness = await Harness.open(await openNodeSqliteStorage(join(dir, "coded.sqlite")), { models, registry, settings }, context);
    let sentToModel = "";
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("probe_coded", {}), { stopReason: "toolUse" }),
      (modelContext) => {
        sentToModel = JSON.stringify(modelContext.messages.filter((message) => message.role === "toolResult").map((message) => message.content));
        return fauxAssistantMessage("done");
      },
    ]);
    const codedConversation = await codedHarness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    await codedConversation.submit({ type: "input", content: "use the coded tool" }, context);
    await codedConversation.waitForIdle(context);
    const codedEntries = await codedConversation.entries({}, 100, undefined, context);
    const stored = codedEntries.items
      .map((entry) => entry.model?.[0] as { role?: string; details?: unknown } | undefined)
      .find((message) => message?.role === "toolResult");
    check(
      "a tool result's details are stored on the toolResult entry",
      JSON.stringify(stored?.details) === JSON.stringify({ code: "probe_code_xyz" }),
      JSON.stringify(stored?.details),
    );
    check(
      "the content of the toolResult carries the text only, not the details (pi-ai's providers send content alone)",
      sentToModel.includes("plain words") && !sentToModel.includes("probe_code_xyz"),
      sentToModel,
    );
    await codedHarness.close(context);
  }

  // 8. A background timer survives a restart across its due time; its result and finish commit together.
  {
    const Fired = defineDoc<{ items: string[] }>({
      kind: "probe.fired",
      version: 1,
      scope: "session",
      checkpointWhen: () => false,
      initial: () => ({ items: [] }),
    });
    const Timer = defineTask<{ at: number }, { phase: "wait" } | { phase: "fire" }, string>({
      name: "probe.timer",
      version: 1,
      initial: () => ({ phase: "wait" }),
      phases: {
        wait: async (task, runtime, taskContext) => {
          await runtime.sleepUntil(task.input.at, { phase: "fire" }, taskContext);
        },
        fire: async (_task, runtime, taskContext) => {
          await runtime.commit(async (tx) => {
            (await tx.doc(Fired)).items.push(String(runtime.taskId));
            return { status: "terminal", outcome: { status: "completed", result: "fired" } };
          }, taskContext);
        },
      },
      abort: async (_task, runtime, taskContext) => {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
      },
    });
    const startTimer = defineTool({
      name: "start_timer",
      description: "Probe timer",
      parameters: Type.Object({}),
      replay: "unsafe",
      execute: async (_args, api, toolContext) => {
        await api.createTask(Timer, { at: Date.now() + 1500 }, { ownership: { kind: "conversation" }, background: true }, toolContext);
        return { output: [{ type: "text", text: "started" }] };
      },
    });
    const timerDb = join(dir, "timer.sqlite");
    // As AgentService does: install the extension after the Harness opens, before resuming, so leftover tasks find their code.
    const openTimer = async () => {
      const registry = createRegistry();
      const opened = await Harness.open(await openNodeSqliteStorage(timerDb), { models, registry, settings }, context);
      registry.install(defineExtension({ name: "probe-timer", tools: [startTimer], tasks: [Timer] }));
      return opened;
    };
    faux.setResponses([() => fauxAssistantMessage(fauxToolCall("start_timer", {}), { stopReason: "toolUse" }), () => fauxAssistantMessage("timer started")]);
    let timerHarness = await openTimer();
    const timerConversation = await timerHarness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    await (await timerConversation.submit({ type: "input", content: "start" }, context)).wait(context);
    const idle = await Promise.race([
      timerConversation.waitForIdle(context).then(() => "idle"),
      new Promise((resolve) => setTimeout(() => resolve("busy"), 500)),
    ]);
    check("conversation is idle while a background timer task waits", idle === "idle", String(idle));
    await timerHarness.close(context);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    timerHarness = await openTimer();
    timerHarness.resume();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const fired = await timerHarness.snapshot(Fired, context);
    check(
      "an extension installed after open and before resume still runs a task an earlier run left (fires once)",
      fired?.items.length === 1,
      `fired=${fired?.items.length}`,
    );
    // abortTask on a sleeping background task settles it through the task's abort handler; it never fires.
    const reopenedTimer = await timerHarness.conversation(timerConversation.id, context);
    if (!reopenedTimer) throw new Error("timer conversation missing after reopen");
    const doomed = await reopenedTimer.commit(
      (tx) => tx.createTask(Timer, { at: Date.now() + 800 }, { ownership: { kind: "conversation" }, background: true }),
      context,
    );
    const aborted = await timerHarness.abortTask(doomed, context);
    const settledTask = await timerHarness.waitForTask(doomed, context);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterAbort = await timerHarness.snapshot(Fired, context);
    check(
      "abortTask stops a sleeping background task before it fires",
      aborted === "marked" && settledTask.state.outcome.status === "aborted" && afterAbort?.items.length === 1,
      `${aborted} ${settledTask.state.outcome.status} fired=${afterAbort?.items.length}`,
    );
    check("abortTask on a finished task reports terminal", (await timerHarness.abortTask(doomed, context)) === "terminal");
    // `AgentService.unschedule` tells a scheduled task from anything else, and from no task, by what `getTask` says.
    const known = await timerHarness.getTask(doomed, context);
    const unknown = await timerHarness.getTask(987_654 as typeof doomed, context);
    check(
      "getTask names the task definition as `kind`, and answers undefined for an ID that is none",
      known?.kind === "probe.timer" && unknown === undefined,
      `${known?.kind} ${unknown}`,
    );
    await timerHarness.close(context);
  }

  // 9. A tool's own model spend is reported in its result and counted under its tool name.
  {
    const spend = {
      input: 120,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const spender = defineTool({
      name: "probe_spender",
      description: "Probe tool with its own spend",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => ({ output: [{ type: "text", text: "answered" }], usage: spend }),
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "probe-spender", tools: [spender] }));
    const usageHarness = await Harness.open(await openNodeSqliteStorage(join(dir, "usage.sqlite")), { models, registry, settings }, context);
    faux.setResponses([() => fauxAssistantMessage(fauxToolCall("probe_spender", {}), { stopReason: "toolUse" }), () => fauxAssistantMessage("done")]);
    const usageConversation = await usageHarness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    await (await usageConversation.submit({ type: "input", content: "spend" }, context)).wait(context);
    const recorded = (await usageHarness.usage(context)).tools.probe_spender;
    check(
      "tool result usage is recorded in pi.usage.tools under the tool name",
      recorded?.input === 120 && recorded.output === 30 && recorded.totalTokens === 150,
      JSON.stringify(recorded),
    );
    await usageHarness.close(context);
  }

  // 10. Usage counts each model response by day, failed ones too; compaction summaries appear only in pi.usage.
  {
    const storage = await openNodeSqliteStorage(join(dir, "report.sqlite"));
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "probe-report",
        tools: [
          defineTool({
            name: "probe_spender",
            description: "Probe tool with its own spend",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async () => ({
              content: [{ type: "text", text: "answered" }],
              usage: {
                input: 7,
                output: 3,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 10,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            }),
          }),
        ],
      }),
    );
    const reportHarness = await Harness.open(storage, { models, registry, settings: { ...settings, retry: { enabled: false } } }, context);
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("probe_spender", {}), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(longAnswer),
      () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
      () => fauxAssistantMessage("## Summary\nprobe summary"),
    ]);
    const reportConversation = await reportHarness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    await (await reportConversation.submit({ type: "input", content: "spend" }, context)).wait(context);
    await (await reportConversation.submit({ type: "input", content: "fail" }, context)).wait(context);
    await reportHarness.waitForTask(await reportConversation.compact(undefined, context), context);

    const listed = await storage.scanConversations({}, 10, undefined, context);
    check(
      "storage.scanConversations lists the conversation",
      listed.items.some((record) => record.id === reportConversation.id),
    );
    const entries = (await storage.scanEntries({ conversationId: reportConversation.id }, 100, undefined, context)).items;
    const messages = entries.flatMap((entry) => entry.model ?? []);
    const assistants = messages.filter((message) => message.role === "assistant");
    check(
      "every model response, a failed one too, is an assistant message with timestamp and usage",
      assistants.length === 3 && assistants.some((m) => m.stopReason === "error") && assistants.every((m) => m.timestamp > 0 && m.usage.totalTokens > 0),
      assistants.map((m) => `${m.stopReason}:${m.usage.totalTokens}`).join(","),
    );
    const toolResult = messages.find((message) => message.role === "toolResult");
    check("a tool's own spend is on its toolResult message", toolResult?.role === "toolResult" && toolResult.usage?.totalTokens === 10);
    const compaction = entries.find((entry) => CompactionEntry.is(entry));
    const inEntries = assistants.reduce((total, m) => total + m.usage.totalTokens, 0);
    const ledger = (await reportHarness.usage(context)).models["faux/probe"]?.totalTokens ?? 0;
    check(
      "a compaction summary is counted in pi.usage but carried by no entry",
      compaction !== undefined && !compaction.model?.some((m) => "usage" in m) && ledger > inEntries,
      `ledger=${ledger} entries=${inEntries}`,
    );
    await reportHarness.close(context);
  }

  // 11. Settings: a multi-document commit is atomic, a throwing commit leaves nothing changed, and all survives a reopen.
  {
    const Edits = defineDoc<{ edits: Record<string, string>; versions: Record<string, number> }>({
      kind: "app.probe-edits",
      version: 1,
      scope: "session",
      checkpointWhen: () => false,
      initial: () => ({ edits: {}, versions: {} }),
    });
    const Log = defineDoc<{ items: { seq: number; id: string }[] }>({
      kind: "app.probe-log",
      version: 1,
      scope: "session",
      checkpointWhen: () => false,
      initial: () => ({ items: [] }),
    });
    const path = join(dir, "settings.sqlite");
    const open = async () => Harness.open(await openNodeSqliteStorage(path), { models, registry: createRegistry(), settings }, context);
    let settingsHarness = await open();
    await settingsHarness.commit(async (tx) => {
      const doc = await tx.doc(Edits);
      doc.edits["system.preamble"] = "terse";
      doc.versions["system.preamble"] = 1;
      (await tx.doc(Log)).items.push({ seq: 1, id: "system.preamble" });
    }, context);
    const thrown = await settingsHarness
      .commit(async (tx) => {
        const doc = await tx.doc(Edits);
        // Throwing before a change is what the settings do on a version conflict; throwing after one is checked too.
        doc.edits["system.preamble"] = "changed";
        (await tx.doc(Log)).items.push({ seq: 2, id: "system.preamble" });
        throw new Error("conflict");
      }, context)
      .then(
        () => false,
        (error: unknown) => error instanceof Error && error.message === "conflict",
      );
    const afterThrow = { edits: await settingsHarness.snapshot(Edits, context), log: await settingsHarness.snapshot(Log, context) };
    check(
      "a commit whose callback throws rejects with that error and changes neither document",
      thrown && afterThrow.edits?.edits["system.preamble"] === "terse" && afterThrow.log?.items.length === 1,
      JSON.stringify(afterThrow),
    );
    await settingsHarness.commit(async (tx) => {
      const doc = await tx.doc(Edits);
      doc.edits["budget.notice"] = "stop";
      delete doc.edits["system.preamble"];
      doc.versions["system.preamble"] = 2;
    }, context);
    await settingsHarness.close(context);
    settingsHarness = await open();
    const reopened = await settingsHarness.snapshot(Edits, context);
    const log = await settingsHarness.snapshot(Log, context);
    check(
      "two documents edited in one commit, a record key assigned and deleted: all of it persists across reopen",
      reopened?.edits["budget.notice"] === "stop" &&
        reopened.edits["system.preamble"] === undefined &&
        !("system.preamble" in reopened.edits) &&
        reopened.versions["system.preamble"] === 2 &&
        log?.items.length === 1,
      JSON.stringify({ reopened, log }),
    );
    await settingsHarness.close(context);
  }

  // 12. Keyed documents: family listing is paged and skips retired members; a member and a singleton commit together; many small commits stay cheap.
  {
    const Account = defineDocFamily<{ cursor: string; seen: string[] }, string>({
      kind: "app.probe-account",
      version: 1,
      scope: "session",
      checkpointWhen: () => false,
      family: true,
      initial: () => ({ cursor: "", seen: [] }),
    });
    const Other = defineDocFamily<{ n: number }, number>({
      kind: "app.probe-other",
      version: 1,
      scope: "session",
      checkpointWhen: () => false,
      family: true,
      initial: (n) => ({ n }),
    });
    const Counter = defineDoc<{ n: number }>({
      kind: "app.probe-counter",
      version: 1,
      scope: "session",
      checkpointWhen: () => false,
      initial: () => ({ n: 0 }),
    });
    const path = join(dir, "channel.sqlite");
    const openAt = async () => {
      const storage = await openNodeSqliteStorage(path);
      return { storage, harness: await Harness.open(storage, { models, registry: createRegistry(), settings }, context) };
    };
    const listKeys = async (storage: Storage, kind: string) => {
      const keys: string[] = [];
      let pages = 0;
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind }, 40, cursor, context);
        pages++;
        for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
        cursor = page.next;
      } while (cursor);
      return { keys, pages };
    };

    let opened = await openAt();
    const userIds = Array.from({ length: 100 }, (_, i) => `u${String(i).padStart(3, "0")}@example.test`);
    await opened.harness.commit(async (tx) => {
      for (const userId of userIds) (await tx.doc(Account, userId, userId)).cursor = "c0";
      await tx.doc(Other, "x", 1);
      (await tx.doc(Counter)).n = 1;
    }, context);
    const listed = await listKeys(opened.storage, "app.probe-account");
    check(
      "scanDocuments lists every member of one family by kind, paged, and only that kind",
      listed.keys.length === 100 && new Set(listed.keys).size === 100 && listed.pages >= 3 && !listed.keys.includes("x"),
      `${listed.keys.length} keys in ${listed.pages} pages`,
    );

    await opened.harness.commit(async (tx) => {
      await tx.retireDoc(Account, userIds[0] as string);
    }, context);
    const afterRetire = await listKeys(opened.storage, "app.probe-account");
    check(
      "a retired family member is no longer listed and snapshot of it is undefined",
      afterRetire.keys.length === 99 &&
        !afterRetire.keys.includes(userIds[0] as string) &&
        (await opened.harness.snapshot(Account, userIds[0] as string, context)) === undefined,
      `${afterRetire.keys.length} keys`,
    );

    const rejected = await opened.harness
      .commit(async (tx) => {
        (await tx.doc(Account, userIds[1] as string, userIds[1] as string)).cursor = "changed";
        (await tx.doc(Counter)).n = 99;
        throw new Error("conflict");
      }, context)
      .then(
        () => false,
        (error: unknown) => error instanceof Error && error.message === "conflict",
      );
    const untouched = {
      account: await opened.harness.snapshot(Account, userIds[1] as string, context),
      counter: await opened.harness.snapshot(Counter, context),
    };
    check(
      "a family member and a singleton changed in a commit that throws: neither changes",
      rejected && untouched.account?.cursor === "c0" && untouched.counter?.n === 1,
      JSON.stringify(untouched),
    );

    // Many small commits on one member: a cursor moves and a capped list of seen IDs rolls over, as a polling account does.
    const target = userIds[2] as string;
    const rounds = 1000;
    const storedBytes = () => [path, `${path}-wal`].reduce((sum, file) => sum + (existsSync(file) ? statSync(file).size : 0), 0);
    const sizeBefore = storedBytes();
    const startedAt = performance.now();
    for (let i = 0; i < rounds; i++) {
      await opened.harness.commit(async (tx) => {
        const doc = await tx.doc(Account, target, target);
        doc.cursor = `c${i + 1}-${"x".repeat(120)}`;
        doc.seen.push(`7513200536450697${String(i).padStart(3, "0")}`);
        if (doc.seen.length > 200) doc.seen.splice(0, doc.seen.length - 200);
      }, context);
    }
    const perCommit = (performance.now() - startedAt) / rounds;
    const growthKb = (storedBytes() - sizeBefore) / 1024;
    const rolled = await opened.harness.snapshot(Account, target, context);
    console.log(`     ${rounds} small commits: ${perCommit.toFixed(2)} ms each, file grew ${growthKb.toFixed(0)} KiB`);
    check(
      "1000 small commits on one member stay under 25 ms each and 20 MiB of growth, with the capped list intact",
      perCommit < 25 && growthKb < 20 * 1024 && rolled?.seen.length === 200 && rolled.cursor.startsWith(`c${rounds}-`),
      `${perCommit.toFixed(2)} ms, ${growthKb.toFixed(0)} KiB, seen ${rolled?.seen.length}`,
    );

    // A hundred accounts commit at the same moment, each its own key, as 100 polling accounts would.
    const parallelStart = performance.now();
    const outcomes = await Promise.allSettled(
      userIds.slice(1).map((userId, i) =>
        opened.harness.commit(async (tx) => {
          (await tx.doc(Account, userId, userId)).cursor = `p${i}`;
        }, context),
      ),
    );
    const parallelMs = performance.now() - parallelStart;
    const failed = outcomes.filter((o) => o.status === "rejected");
    const samples = await Promise.all(
      [3, 50, 98].map((i) => opened.harness.snapshot(Account, userIds[i + 1] as string, context).then((doc) => doc?.cursor === `p${i}`)),
    );
    console.log(`     99 concurrent commits on different keys: ${parallelMs.toFixed(0)} ms`);
    check("99 concurrent commits on different keys all succeed and land", failed.length === 0 && samples.every(Boolean), `${failed.length} failed`);

    await opened.harness.close(context);
    opened = await openAt();
    const reopenedList = await listKeys(opened.storage, "app.probe-account");
    const reopenedDoc = await opened.harness.snapshot(Account, target, context);
    check(
      "after reopen the family lists the same members and the rolled list is intact",
      reopenedList.keys.length === 99 && reopenedDoc?.seen.length === 200,
      `${reopenedList.keys.length} keys`,
    );
    await opened.harness.close(context);
  }

  // 13. A checkpoint stores the change as a base and deletes older revisions, so the file stops growing with changes.
  {
    const kept = defineDoc<{ items: string[] }>({
      kind: "app.probe-kept",
      version: 1,
      scope: "session",
      checkpointWhen: () => false,
      initial: () => ({ items: [] }),
    });
    const based = defineDoc<{ items: string[] }>({
      kind: "app.probe-based",
      version: 1,
      scope: "session",
      initial: () => ({ items: [] }),
      checkpointWhen: (value) => value.items.length === 0,
    });
    const text = "a message the queue holds until it is delivered ".repeat(4);
    /** A queue that fills and empties `rounds` times, as the outbox does with each answered turn; measured once closed. */
    const run = async (name: string, doc: typeof kept, rounds: number) => {
      const path = join(dir, `${name}-${rounds}.sqlite`);
      const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry: createRegistry(), settings }, context);
      for (let i = 0; i < rounds; i++) {
        await harness.commit(async (tx) => void (await tx.doc(doc)).items.push(`${i} ${text}`), context);
        await harness.commit(async (tx) => void (await tx.doc(doc)).items.splice(0, 1), context);
      }
      await harness.close(context);
      const bytes = [path, `${path}-wal`].reduce((sum, file) => sum + (existsSync(file) ? statSync(file).size : 0), 0);
      const storage = await openNodeSqliteStorage(path);
      const page = await storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: doc.definition.kind }, 1, undefined, context);
      const stored = page.items[0] ? await storage.document(page.items[0].id, "current", context) : undefined;
      await storage.close(context);
      return { bytes, replayed: stored?.deltasSinceBase, value: stored?.value };
    };
    // What 500 more rounds add, so the file's fixed size does not count.
    const rounds = 520;
    const grows = async (name: string, doc: typeof kept) => {
      const few = await run(name, doc, 20);
      const many = await run(name, doc, rounds);
      return { ...many, bytes: many.bytes - few.bytes };
    };
    const without = await grows("kept", kept);
    const withCheckpoint = await grows("based", based);
    console.log(
      `     500 more fill-and-empty rounds: without a checkpoint the file grows ${(without.bytes / 1024).toFixed(0)} KiB and a read replays ${without.replayed} changes; with one ${(withCheckpoint.bytes / 1024).toFixed(0)} KiB and ${withCheckpoint.replayed}`,
    );
    check(
      "without checkpointWhen a session document keeps every change, and a read replays them all",
      without.replayed === rounds * 2 - 1,
      `${without.replayed} replayed`,
    );
    check(
      "with checkpointWhen the change is stored whole, older revisions go, and a read replays none of the past",
      withCheckpoint.replayed === 0 && JSON.stringify(withCheckpoint.value) === JSON.stringify({ items: [] }) && withCheckpoint.bytes * 4 < without.bytes,
      `${withCheckpoint.replayed} replayed, grew ${withCheckpoint.bytes} vs ${without.bytes} bytes`,
    );
  }

  // 14. Shape changes: an older stored version is converted by `migrate` on read; a newer one, or an older one without `migrate`, throws.
  {
    const path = join(dir, "migrate.sqlite");
    const open = async () => Harness.open(await openNodeSqliteStorage(path), { models, registry: createRegistry(), settings }, context);
    type V1 = { name: string };
    type V2 = { first: string; last: string };
    const single1 = defineDoc<V1>({ kind: "app.probe-shape", version: 1, scope: "session", checkpointWhen: () => false, initial: () => ({ name: "" }) });
    const family1 = defineDocFamily<V1, string>({
      kind: "app.probe-shapes",
      version: 1,
      scope: "session",
      checkpointWhen: () => false,
      family: true,
      initial: (name) => ({ name }),
    });
    const split = (value: V1 | Record<string, unknown>): V2 => {
      const [first = "", last = ""] = String((value as V1).name).split(" ");
      return { first, last };
    };
    const single2 = defineDoc<V2>({
      kind: "app.probe-shape",
      version: 2,
      scope: "session",
      checkpointWhen: () => false,
      initial: () => ({ first: "", last: "" }),
      migrate: (value) => split(value),
    });
    const family2 = defineDocFamily<V2, string>({
      kind: "app.probe-shapes",
      version: 2,
      scope: "session",
      checkpointWhen: () => false,
      family: true,
      initial: () => ({ first: "", last: "" }),
      migrate: (value) => split(value),
    });
    const single2Bare = defineDoc<V2>({
      kind: "app.probe-shape",
      version: 2,
      scope: "session",
      checkpointWhen: () => false,
      initial: () => ({ first: "", last: "" }),
    });
    const throws = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return false;
      } catch {
        return true;
      }
    };
    /** The stored version of the singleton's current revision. */
    const storedVersion = async (kind: string) => {
      const storage = await openNodeSqliteStorage(path);
      const page = await storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind }, 1, undefined, context);
      const stored = page.items[0] ? await storage.document(page.items[0].id, "current", context) : undefined;
      await storage.close(context);
      return stored?.version;
    };

    let opened = await open();
    await opened.commit(async (tx) => {
      (await tx.doc(single1)).name = "Ada Lovelace";
      await tx.doc(family1, "k", "Grace Hopper");
    }, context);
    await opened.close(context);

    opened = await open();
    const bareFails = await throws(() => opened.snapshot(single2Bare, context));
    check("an older stored version without migrate throws on read", bareFails);
    const migrated = await opened.snapshot(single2, context);
    const migratedMember = await opened.snapshot(family2, "k", context);
    check(
      "migrate converts a singleton and a family member when read",
      migrated?.first === "Ada" && migrated.last === "Lovelace" && migratedMember?.first === "Grace" && migratedMember.last === "Hopper",
      JSON.stringify([migrated, migratedMember]),
    );
    check("reading alone leaves the stored version at 1", (await storedVersion("app.probe-shape")) === 1);
    await opened.commit(async (tx) => {
      (await tx.doc(single2)).last = "King";
    }, context);
    await opened.close(context);
    check("a commit stores the migrated document at version 2", (await storedVersion("app.probe-shape")) === 2, String(await storedVersion("app.probe-shape")));

    opened = await open();
    const afterReopen = await opened.snapshot(single2, context);
    check("the migrated and edited value survives reopen", afterReopen?.first === "Ada" && afterReopen.last === "King", JSON.stringify(afterReopen));
    check("old code cannot read a document stored at a newer version", await throws(() => opened.snapshot(single1, context)));
    await opened.close(context);
  }

  // Per-conversation model: `configure` moves a conversation between catalog models from its next request, even mid-run.
  {
    const answer = `${"word ".repeat(120)}end`;
    const pair = fauxProvider({
      models: [
        { id: "big", contextWindow: 100_000, maxTokens: 1000 },
        { id: "small", contextWindow: 700, maxTokens: 200 },
      ],
      tokensPerSecond: 200,
    });
    pair.setResponses(
      Array.from({ length: 30 }, () => (transcript) => {
        const first = transcript.messages[0];
        if (first?.role === "system" && typeof first.content === "string" && first.content.includes("summarization")) {
          return fauxAssistantMessage("## Summary\nprobe summary");
        }
        return fauxAssistantMessage(answer);
      }),
    );
    const pairModels = createModels();
    pairModels.setProvider(pair.provider);
    const big = { provider: "faux", modelId: "big" };
    const small = { provider: "faux", modelId: "small" };
    const switching = await Harness.open(
      await openNodeSqliteStorage(join(dir, "model-switch.sqlite")),
      { models: pairModels, registry: createRegistry(), settings: { retry: { enabled: false }, compaction: { reserveTokens: 100, keepRecentTokens: 50 } } },
      context,
    );
    const made = await switching.createConversation({ ownership: { kind: "ownerless" }, agent: { model: big, thinkingLevel: "minimal" } }, context);
    const target = await switching.conversation(made.id, context);
    if (!target) throw new Error("conversation missing");
    // Newest first, as `entries` lists them.
    const answeredBy = async () =>
      (await target.entries({}, 50, undefined, context)).items
        .filter((entry) => AssistantEntry.is(entry))
        .map((entry) => (entry.model?.[0] as AssistantMessage | undefined)?.model);
    const send = async (requestId: string) => {
      const settled = await (await target.submit({ type: "input", content: requestId, requestId }, context)).wait(context);
      await switching.waitForIdle(context);
      return settled;
    };

    await send("m1");
    await switching.commit((tx) => configure(tx, made.id, { model: small }), context);
    const stored = (await switching.snapshot(AgentDoc, made.id, context))?.model;
    check(
      "configure moves an idle conversation to another model of the catalog",
      stored?.provider === "faux" && stored.modelId === "small",
      JSON.stringify(stored),
    );

    const onSmall = await send("m2");
    const afterSmall = await target.entries({}, 50, undefined, context);
    check("a turn after configure is answered by the new model", (await answeredBy())[0] === "small", JSON.stringify(await answeredBy()));
    check(
      "a window smaller than the context compacts and the turn still completes",
      onSmall.status === "done" && afterSmall.items.some((entry) => CompactionEntry.is(entry)),
      onSmall.status,
    );

    await switching.commit((tx) => configure(tx, made.id, { model: big }), context);
    const inFlight = await target.submit({ type: "input", content: "m3", requestId: "m3" }, context);
    await new Promise((resolve) => setTimeout(resolve, 150));
    let configureError = "";
    try {
      await switching.commit((tx) => configure(tx, made.id, { model: small }), context);
    } catch (error) {
      configureError = String(error);
    }
    await inFlight.wait(context);
    await switching.waitForIdle(context);
    check("configure while a run is in flight is accepted", configureError === "", configureError);
    check("the run in flight keeps its model", (await answeredBy())[0] === "big", JSON.stringify(await answeredBy()));
    await send("m4");
    check("the next turn uses the model configured during the run", (await answeredBy())[0] === "small", JSON.stringify(await answeredBy()));
    await switching.close(context);
  }

  await harness.close(context);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
