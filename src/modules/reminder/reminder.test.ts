import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { AgentService, type Notice } from "../../kernel/index.ts";
import { formatLocal } from "../../platform/local-time.ts";
import { captureLogs, fauxSetup, tempDirPerTest, toolDeps } from "../../testing/testing.ts";
import { builtinExtensions } from "../../testing/tools.ts";
import { MAX_PENDING_REMINDERS } from "./reminder.ts";

/** Keys that start with `prefix`, the way the tests group conversations by channel. */
const on = (prefix: string) => (key: string) => key.startsWith(prefix);

const { faux, models, model } = fauxSetup();

const dir = tempDirPerTest("reminder-");
let service: AgentService | undefined;

const open = () =>
  AgentService.open({
    databasePath: join(dir(), "agent.sqlite"),
    models,
    model,
    settings: { retry: { enabled: false } },
    extensions: (host) => builtinExtensions(toolDeps({ ...host })),
  });

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Calls set_reminder once per `calls` entry (computed when the model "answers"), then quotes every tool result. */
function scheduleThenQuote(calls: () => { at: string; text: string }[]) {
  const respond = (transcript: TranscriptContext): AssistantMessage => {
    const results = transcript.messages.filter((message) => message.role === "toolResult");
    if (results.length === 0) {
      return fauxAssistantMessage(
        calls().map((call, index) => fauxToolCall("set_reminder", call, { id: `call-${index}` })),
        { stopReason: "toolUse" },
      );
    }
    const quoted = results.map((result) => (result.details as { code?: string } | undefined)?.code ?? "");
    return fauxAssistantMessage(`codes: ${quoted.join(" | ")}`);
  };
  // One model call asks for the tools, the next one answers.
  return [respond, respond];
}

const nextNotice = (target: AgentService) =>
  new Promise<Notice>((resolve) => {
    const stop = target.onNotice((notice) => {
      stop();
      resolve(notice);
    });
  });

beforeEach(async () => {
  service = await open();
});

afterEach(async () => {
  await service?.close();
  service = undefined;
});

test("set and list speak local time: the instant is not echoed as UTC", async () => {
  const at = inMs(3_600_000);
  faux.setResponses(rounds([{ name: "set_reminder", args: { at, text: "stretch" } }], [{ name: "list_reminders", args: {} }]));
  const answer = await (await (service as AgentService).send("feishu:42", "remind me", "r1")).answer;
  expect(answer.split(formatLocal(new Date(at))).length - 1).toBe(2);
  expect(answer).not.toContain(at);
});

test("a due reminder becomes a notice for the calling key, then disappears once confirmed", async () => {
  faux.setResponses(scheduleThenQuote(() => [{ at: inMs(700), text: "drink water" }]));
  const fired = nextNotice(service as AgentService);
  const answer = await (await (service as AgentService).send("feishu:42", "remind me", "r1")).answer;
  expect(answer).toContain("codes: set");

  const notice = await fired;
  expect(notice).toMatchObject({ key: "feishu:42", text: "drink water" });
  expect(notice.dueAt).toBeLessThanOrEqual(Date.now());
  expect(await (service as AgentService).notices(on("feishu:"))).toHaveLength(1);
  expect(await (service as AgentService).notices(on("terminal"))).toHaveLength(0);

  await (service as AgentService).ackNotice(notice.id);
  expect(await (service as AgentService).notices(on("feishu:"))).toHaveLength(0);
});

const textOf = (notice: Notice) => ("text" in notice ? notice.text : undefined);

test("a reminder that came due while the process was down fires after reopen and survives until confirmed", async () => {
  faux.setResponses(scheduleThenQuote(() => [{ at: inMs(900), text: "stand up" }]));
  await (
    await (service as AgentService).send("feishu:42", "remind me", "r1")
  ).answer;
  await (service as AgentService).close();
  service = undefined;
  await new Promise((resolve) => setTimeout(resolve, 1200));

  service = await open();
  const fired = await service.notices(on("feishu:")).then((list) => (list.length > 0 ? list : nextNotice(service as AgentService).then((n) => [n])));
  expect(fired.map(textOf)).toEqual(["stand up"]);

  // Unconfirmed, so a further restart still has it.
  await service.close();
  service = await open();
  expect((await service.notices(on("feishu:"))).map(textOf)).toEqual(["stand up"]);
});

test("a past time, a time without a time of day and an over-limit batch are refused with a reason", async () => {
  const far = inMs(3_600_000);
  faux.setResponses(
    scheduleThenQuote(() => [
      { at: inMs(-1000), text: "late" },
      { at: "2099-01-01", text: "date only" },
      ...Array.from({ length: MAX_PENDING_REMINDERS + 1 }, (_, index) => ({ at: far, text: `r${index}` })),
    ]),
  );
  const answer = await (await (service as AgentService).send("feishu:42", "remind me a lot", "r1")).answer;
  const results = answer.replace("codes: ", "").split(" | ");
  expect(results[0]).toBe("not_future");
  expect(results[1]).toBe("invalid_at");
  expect(results.slice(2, -1).every((code) => code === "set")).toBe(true);
  expect(results.slice(2, -1)).toHaveLength(MAX_PENDING_REMINDERS);
  expect(results.at(-1)).toBe("limit");
});

/** One tool round per entry: each entry's calls run, and its results are quoted by the next model call. */
function rounds(...steps: { name: string; args: Record<string, string> }[][]) {
  const respond = (transcript: TranscriptContext): AssistantMessage => {
    // Only this turn's messages: earlier turns stay in the transcript.
    const turnStart = transcript.messages.findLastIndex((message) => message.role === "user");
    const turn = transcript.messages.slice(turnStart);
    const done = turn.filter((message) => message.role === "assistant").length;
    const step = steps[done];
    if (step !== undefined) {
      return fauxAssistantMessage(
        step.map((call, index) => fauxToolCall(call.name, call.args, { id: `r${done}-${index}` })),
        { stopReason: "toolUse" },
      );
    }
    const results = turn.filter((message) => message.role === "toolResult");
    const quoted = results.map((result) => {
      const code = (result.details as { code?: string } | undefined)?.code ?? "?";
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      return `${code}:${text}`;
    });
    return fauxAssistantMessage(`results: ${quoted.join(" | ")}`);
  };
  return Array.from({ length: steps.length + 1 }, () => respond);
}

test("list_reminders shows waiting reminders and cancel_reminder stops one from ever firing", async () => {
  const target = service as AgentService;
  faux.setResponses(
    rounds(
      [
        { name: "set_reminder", args: { at: inMs(60_000), text: "later" } },
        { name: "set_reminder", args: { at: inMs(900), text: "soon" } },
      ],
      [{ name: "list_reminders", args: {} }],
    ),
  );
  const listed = await (await target.send("feishu:42", "set two", "r1")).answer;
  expect(listed).toMatch(/\d+: .* — soon\n\d+: .* — later/);
  const soonId = /(\d+): [^\n]* — soon/.exec(listed)?.[1] ?? "";

  faux.setResponses(rounds([{ name: "cancel_reminder", args: { id: soonId } }], [{ name: "list_reminders", args: {} }]));
  const afterCancel = await (await target.send("feishu:42", "cancel soon", "r2")).answer;
  expect(afterCancel).toContain("cancelled:");
  expect(afterCancel).not.toContain("— soon\n");
  expect(afterCancel).toContain("listed:");
  expect(afterCancel).toContain("— later");

  await new Promise((resolve) => setTimeout(resolve, 1400));
  expect(await target.notices(on("feishu:"))).toEqual([]);
});

test("cancel_reminder refuses an unknown id and another chat's reminder", async () => {
  const target = service as AgentService;
  faux.setResponses(rounds([{ name: "set_reminder", args: { at: inMs(60_000), text: "mine" } }], [{ name: "list_reminders", args: {} }]));
  const listed = await (await target.send("feishu:1", "set", "r1")).answer;
  const id = /(\d+): [^\n]* — mine/.exec(listed)?.[1] ?? "";

  faux.setResponses(
    rounds([
      { name: "cancel_reminder", args: { id } },
      { name: "cancel_reminder", args: { id: "999999" } },
    ]),
  );
  const refused = await (await target.send("feishu:2", "cancel", "r2")).answer;
  expect(refused.match(/No waiting reminder/g)).toHaveLength(2);

  faux.setResponses(rounds([{ name: "list_reminders", args: {} }]));
  expect(await (await target.send("feishu:1", "list", "r3")).answer).toContain("— mine");
});

test("setting and cancelling a reminder is logged", async () => {
  const target = service as AgentService;
  let id = "";
  const lines = await captureLogs(async () => {
    faux.setResponses(rounds([{ name: "set_reminder", args: { at: inMs(60_000), text: "mine" } }], [{ name: "list_reminders", args: {} }]));
    id = /(\d+): [^\n]* — mine/.exec(await (await target.send("feishu:1", "set", "r1")).answer)?.[1] ?? "";
    faux.setResponses(rounds([{ name: "cancel_reminder", args: { id } }]));
    await (
      await target.send("feishu:1", "cancel", "r2")
    ).answer;
  });
  const text = lines.map((entry) => entry.line).join("\n");
  expect(text).toMatch(/ reminder\.set key=feishu:1 at=\S+ waiting=1/);
  expect(text).toContain(` reminder.cancelled id=${id}`);
});
