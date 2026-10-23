import { expect, test } from "bun:test";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { fauxSetup, tempDirPerTest, toolDeps } from "../../testing/testing.ts";
import { builtinExtensions } from "../../testing/tools.ts";
import { AgentService } from "../index.ts";
import { KERNEL_PROMPTS as PROMPT_DEFAULTS } from "../prompts.ts";
import { toolRoundsThisTurn, withToolBudget } from "./tool-budget.ts";

const BUDGET_NOTICE = PROMPT_DEFAULTS["budget.notice"].text;

import { messageText } from "./transcript.ts";

const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const toolRound = (): Message => ({ ...fauxAssistantMessage(fauxToolCall("current_time", {}), { stopReason: "toolUse" }) });
const result = (): Message => ({
  role: "toolResult",
  toolCallId: "c",
  toolName: "current_time",
  content: [{ type: "text", text: "now" }],
  isError: false,
  timestamp: 1,
});
const answer = (): Message => ({ ...fauxAssistantMessage("done") });

test("only tool rounds since the last user message count", () => {
  const earlier = [user("q1"), toolRound(), result(), toolRound(), result(), answer()];
  // The rounds before q2 belong to q1's turn.
  expect(toolRoundsThisTurn(earlier)).toBe(2);
  expect(toolRoundsThisTurn([...earlier, user("q2")])).toBe(0);
  expect(toolRoundsThisTurn([...earlier, user("q2"), toolRound(), result(), toolRound(), result()])).toBe(2);
});

test("below the budget nothing changes; at it, the notice is appended without touching earlier messages", () => {
  const turn = [user("q"), toolRound(), result(), toolRound(), result()];
  expect(withToolBudget(turn, 3, 5, BUDGET_NOTICE)).toBeUndefined();
  const wrapped = withToolBudget(turn, 2, 5, BUDGET_NOTICE);
  expect(wrapped?.slice(0, turn.length)).toEqual(turn);
  expect(wrapped?.length).toBe(turn.length + 1);
  expect(wrapped?.at(-1)).toEqual({ role: "user", content: BUDGET_NOTICE, timestamp: 5 });
});

const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("tool-budget-");

test("a model that keeps calling tools is told to stop, the notice never reaches the transcript, and an obedient model ends the turn", async () => {
  const service = await AgentService.open({
    databasePath: `${dir()}/agent.sqlite`,
    models,
    model,
    maxToolRounds: 3,
    settings: { retry: { enabled: false } },
    extensions: (host) => builtinExtensions(toolDeps({ ...host })),
  });
  try {
    const requests: Message[][] = [];
    const respond = (transcript: { messages: Message[] }): AssistantMessage => {
      requests.push(transcript.messages);
      const told = transcript.messages.at(-1)?.role === "user" && messageText(transcript.messages.at(-1)) === BUDGET_NOTICE;
      return told ? fauxAssistantMessage("Here is what I have.") : fauxAssistantMessage(fauxToolCall("current_time", {}), { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 10 }, () => respond));
    const final = await (await service.send("k", "keep going", "r1")).answer;
    expect(final).toBe("Here is what I have.");
    // Three tool rounds, then the request that carried the notice.
    expect(requests).toHaveLength(4);
    expect(requests.slice(0, 3).every((messages) => messageText(messages.at(-1)) !== BUDGET_NOTICE)).toBe(true);
    const history = await service.history("k", 20);
    expect(history.map((line) => line.text).join("\n")).not.toContain("tool-call budget");
  } finally {
    await service.close();
  }
});
