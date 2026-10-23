import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { continueOnce, fauxSetup, tempDirPerTest, toolDeps } from "../../testing/testing.ts";
import { builtinExtensions } from "../../testing/tools.ts";
import { type AgentExtension, AgentService, type Turn } from "../index.ts";

// Slow enough that a round's text arrives in several partials.
const slow = fauxSetup({ tokensPerSecond: 100 });
// So fast that a generation is over before its first partial is committed.
const fast = fauxSetup({ tokensPerSecond: 1_000_000 });
const dir = tempDirPerTest("turn-rounds-");
let service: AgentService | undefined;

const words = (label: string) => `${label}: ${"word ".repeat(60)}end.`;

/** `rounds` tool-calling answers, each with text before the call, then a streamed final answer. */
function script(rounds: number) {
  return (transcript: TranscriptContext): AssistantMessage => {
    const done = transcript.messages.filter((message) => message.role === "toolResult").length;
    if (done < rounds) {
      return fauxAssistantMessage([fauxText(words(`round ${done + 1}`)), fauxToolCall("current_time", {}, { id: `call_${done}` })], {
        stopReason: "toolUse",
      });
    }
    return fauxAssistantMessage(words("final"));
  };
}

async function run(
  rounds: number,
  respond = script(rounds),
  extra: AgentExtension[] = [],
  { faux, models, model } = slow,
): Promise<{ chunks: string[]; answer: string; text: string }> {
  faux.setResponses(Array.from({ length: rounds + 1 }, () => respond));
  service = await AgentService.open({
    databasePath: join(dir(), "agent.sqlite"),
    models,
    model,
    settings: { retry: { enabled: false } },
    extensions: (host) => [...builtinExtensions({ ...toolDeps({ now: () => new Date("2026-10-19T08:00:00Z") }), ...host }), ...extra],
  });
  const turn: Turn = await service.send("k", "what time is it", "r1");
  const chunks: string[] = [];
  for await (const chunk of turn.deltas) chunks.push(chunk);
  return { chunks, answer: await turn.answer, text: await turn.text };
}

afterEach(async () => {
  await service?.close();
  service = undefined;
});

/** How many chunks carry part of the text that starts at `marker` and runs to `end` (or the end of the text). */
function chunksOver(chunks: string[], marker: string, end?: string): number {
  const text = chunks.join("");
  const from = text.indexOf(marker);
  const to = end === undefined ? text.length : text.indexOf(end);
  let offset = 0;
  let count = 0;
  for (const chunk of chunks) {
    if (offset < to && offset + chunk.length > from) count++;
    offset += chunk.length;
  }
  return count;
}

test("the text after a tool call streams in increments, not in one piece at the end (R029)", async () => {
  const { chunks, answer } = await run(1);
  expect(answer).toBe(words("final"));
  expect(chunks.join("")).toBe(`${words("round 1")}\n\n${words("final")}`);
  expect(chunksOver(chunks, "round 1:", "final:")).toBeGreaterThan(1);
  expect(chunksOver(chunks, "final:")).toBeGreaterThan(1);
});

test("over several tool rounds every round's text streams and none of it is lost", async () => {
  const { chunks, answer, text } = await run(2);
  expect(answer).toBe(words("final"));
  expect(chunks.join("")).toBe([words("round 1"), words("round 2"), words("final")].join("\n\n"));
  // What is kept once the turn is over.
  expect(text).toBe(chunks.join(""));
  expect(chunksOver(chunks, "round 2:", "final:")).toBeGreaterThan(1);
  expect(chunksOver(chunks, "final:")).toBeGreaterThan(1);
});

test("a generation an extension continues without a tool round keeps its end, and the next one streams after a blank line (R034)", async () => {
  const respond = (transcript: TranscriptContext): AssistantMessage =>
    fauxAssistantMessage(words(transcript.messages.filter((message) => message.role === "user").length > 1 ? "final" : "part 1"));
  const { chunks, answer, text } = await run(1, respond, [continueOnce()]);
  expect(answer).toBe(words("final"));
  expect(chunks.join("")).toBe(`${words("part 1")}\n\n${words("final")}`);
  expect(text).toBe(chunks.join(""));
  expect(chunksOver(chunks, "part 1:", "final:")).toBeGreaterThan(1);
  expect(chunksOver(chunks, "final:")).toBeGreaterThan(1);
});

test("a generation an extension continues before any partial of it was seen is kept whole, and so is a tool round after it", async () => {
  const respond = (transcript: TranscriptContext): AssistantMessage => {
    if (transcript.messages.filter((message) => message.role === "user").length === 1) return fauxAssistantMessage(words("part 1"));
    if (!transcript.messages.some((message) => message.role === "toolResult")) {
      return fauxAssistantMessage([fauxText(words("round 2")), fauxToolCall("current_time", {}, { id: "call_0" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(words("final"));
  };
  const { chunks, answer, text } = await run(2, respond, [continueOnce()], fast);
  expect(answer).toBe(words("final"));
  expect(chunks.join("")).toBe([words("part 1"), words("round 2"), words("final")].join("\n\n"));
  expect(text).toBe(chunks.join(""));
});
