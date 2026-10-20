import { expect, test } from "bun:test";
import type { LiveState, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { type ToolActivity, TurnFeed } from "./turn-feed.ts";

const MINE = 7 as unknown as SubmissionId;
const OTHER = 8 as unknown as SubmissionId;

type Slot = { callId: string; name: string; status: "pending" | "running" | "done" };

/** The part of the live state a feed reads: which inputs are running, the partial answer and the tool round. */
function live(options: { inputs?: SubmissionId[]; partial?: string; tools?: Slot[]; task?: number } = {}): LiveState {
  const { inputs = [MINE], partial, tools, task = 1 } = options;
  return {
    run: { taskId: task, inputs },
    ...(partial === undefined ? {} : { generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: partial }] } } }),
    ...(tools ? { tools } : {}),
  } as unknown as LiveState;
}

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

test("cumulative partials become increments, and the committed answer adds the missing tail", async () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ partial: "Hel" }));
  feed.observe(live({ partial: "Hello wor" }));
  feed.observe(live({ partial: "Hello wor" }));
  feed.complete("Hello world!");
  feed.end();
  const chunks = await drain(feed.deltas);
  expect(chunks.join("")).toBe("Hello world!");
  expect(chunks).not.toContain("");
});

test("chunks that arrive faster than they are read are delivered together", async () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ partial: "a" }));
  feed.observe(live({ partial: "ab" }));
  feed.observe(live({ partial: "abc" }));
  feed.end();
  expect(await drain(feed.deltas)).toEqual(["abc"]);
});

test("a run of another input is ignored", async () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ inputs: [OTHER], partial: "not mine", tools: [{ callId: "x", name: "t", status: "running" }] }));
  feed.observe({} as LiveState);
  feed.observe(undefined);
  feed.end();
  expect(await drain(feed.deltas)).toEqual([]);
  expect(await drain(feed.tools)).toEqual([]);
});

test("when a retry rewrites text that already went out, the answer follows in full after a blank line", async () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ partial: "First try" }));
  feed.observe(live({ partial: "Second" }));
  feed.observe(live({ partial: "Second try goes on" }));
  feed.complete("Second try goes on and ends");
  feed.end();
  expect((await drain(feed.deltas)).join("")).toBe("First try\n\nSecond try goes on and ends");
});

test("each tool call is reported once per status, and a pending call is not reported yet", async () => {
  const feed = new TurnFeed(MINE);
  const slot = (status: Slot["status"]): Slot => ({ callId: "c1", name: "current_time", status });
  feed.observe(live({ tools: [slot("pending")] }));
  feed.observe(live({ tools: [slot("running")] }));
  feed.observe(live({ tools: [slot("running")] }));
  feed.observe(live({ tools: [slot("done")] }));
  feed.observe(live({ tools: [slot("done")] }));
  feed.end();
  const seen: ToolActivity[] = await drain(feed.tools);
  expect(seen).toEqual([
    { callId: "c1", name: "current_time", status: "running" },
    { callId: "c1", name: "current_time", status: "done" },
  ]);
});

test("a call that is only ever seen as done is still reported", async () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ tools: [{ callId: "quick", name: "current_time", status: "done" }] }));
  feed.end();
  expect(await drain(feed.tools)).toEqual([{ callId: "quick", name: "current_time", status: "done" }]);
});

test("both streams end with the feed", async () => {
  const feed = new TurnFeed(MINE);
  const reading = Promise.all([drain(feed.deltas), drain(feed.tools)]);
  feed.observe(live({ partial: "x" }));
  feed.end();
  feed.observe(live({ partial: "xy" }));
  const [text, tools] = await reading;
  expect(text.join("")).toBe("x");
  expect(tools).toEqual([]);
});

test("once the text has diverged, later partials add nothing, even if one happens to extend the first try again", async () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ partial: "First try" }));
  feed.observe(live({ partial: "Other" }));
  feed.observe(live({ partial: "First try and more" }));
  feed.complete("Final");
  feed.end();
  expect((await drain(feed.deltas)).join("")).toBe("First try\n\nFinal");
});

// A generation is one task: a retry is another attempt of it, the generation after a tool round is a new task (R029).
/** Let the reader take what is pending, so the chunks show what streamed when. */
const tick = () => Bun.sleep(1);
const call = (status: Slot["status"] = "running"): Slot[] => [{ callId: "c1", name: "web_search", status }];

test("text after a tool round streams as it comes, after a blank line, and the answer only adds its tail", async () => {
  const feed = new TurnFeed(MINE);
  const reading = drain(feed.deltas);
  feed.observe(live({ partial: "Let me" }));
  await tick();
  feed.observe(live({ partial: "Let me look." }));
  await tick();
  feed.observe(live({ tools: call() }), () => "Let me look.");
  await tick();
  feed.observe(live({ partial: "It is", task: 2 }));
  await tick();
  feed.observe(live({ partial: "It is sunny", task: 2 }));
  await tick();
  feed.complete("It is sunny today.");
  feed.end();
  const chunks = await reading;
  expect(chunks.join("")).toBe("Let me look.\n\nIt is sunny today.");
  expect(chunks).toContain("\n\nIt is");
  expect(chunks).toContain(" sunny");
});

test("the committed tool-calling answer completes text whose last partial was cut short, and is read once", async () => {
  const feed = new TurnFeed(MINE);
  let reads = 0;
  const answered = () => {
    reads++;
    return "Let me look it up.";
  };
  feed.observe(live({ partial: "Let me lo" }));
  feed.observe(live({ tools: call("running") }), answered);
  feed.observe(live({ tools: call("done") }), answered);
  feed.observe(live({ partial: "Found", task: 2 }));
  feed.complete("Found it.");
  feed.end();
  expect((await drain(feed.deltas)).join("")).toBe("Let me look it up.\n\nFound it.");
  expect(reads).toBe(1);
});

test("a tool call without text before it adds no blank line, and several rounds each follow after one", async () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ tools: call() }), () => "");
  feed.observe(live({ partial: "Searched", task: 2 }));
  feed.observe(live({ tools: [{ callId: "c2", name: "web_fetch", status: "running" }], task: 2 }), () => "Searched; opening a page.");
  feed.observe(live({ partial: "The page", task: 3 }));
  feed.complete("The page says yes.");
  feed.end();
  expect((await drain(feed.deltas)).join("")).toBe("Searched; opening a page.\n\nThe page says yes.");
});

test("a final answer whose partials were never seen follows the earlier rounds after a blank line", async () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ partial: "Checking." }));
  feed.observe(live({ tools: call() }), () => "Checking.");
  feed.complete("Done.");
  feed.end();
  expect((await drain(feed.deltas)).join("")).toBe("Checking.\n\nDone.");
  // The text keeps the tool round's text too, as the card does (R034).
  expect(feed.text).toBe("Checking.\n\nDone.");
});

test("a retry rewriting text of the same generation is still a rewrite, not a new round", async () => {
  const feed = new TurnFeed(MINE);
  const reading = drain(feed.deltas);
  feed.observe(live({ partial: "First try", task: 4 }));
  await tick();
  feed.observe(live({ partial: "Second", task: 4 }));
  await tick();
  feed.observe(live({ partial: "Second try goes on", task: 4 }));
  await tick();
  feed.complete("Second try goes on and ends");
  feed.end();
  // Nothing of the rewrite streams; the committed answer follows in full, as before.
  expect(await reading).toEqual(["First try", "\n\nSecond try goes on and ends"]);
});

test("a rewrite in one round does not stop the next round from streaming", async () => {
  const feed = new TurnFeed(MINE);
  const reading = drain(feed.deltas);
  feed.observe(live({ partial: "First try" }));
  await tick();
  feed.observe(live({ partial: "Other" }));
  await tick();
  feed.observe(live({ tools: call() }), () => "Other text.");
  await tick();
  feed.observe(live({ partial: "Then", task: 2 }));
  await tick();
  feed.observe(live({ partial: "Then more", task: 2 }));
  await tick();
  feed.complete("Then more.");
  feed.end();
  const chunks = await reading;
  expect(chunks.join("")).toBe("First try\n\nOther text.\n\nThen more.");
  expect(chunks).toContain(" more");
});

test("the text of a turn keeps every round, a blank line apart, with a rewrite only in its committed form (R033)", () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ partial: "First try" }));
  feed.observe(live({ partial: "Other" }));
  feed.observe(live({ tools: call() }), () => "Other text.");
  feed.observe(live({ tools: [{ callId: "c2", name: "web_fetch", status: "running" }], task: 2 }), () => "");
  feed.observe(live({ partial: "Then", task: 3 }));
  feed.complete("Then more.");
  feed.end();
  expect(feed.text).toBe("Other text.\n\nThen more.");
});

test("the text of a turn without a tool round is its answer", () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ partial: "Hel" }));
  feed.complete("Hello.");
  feed.end();
  expect(feed.text).toBe("Hello.");
});

// An `onYield` continuation hands the run to a new generation in the commit of the answer, with no tool round (R034).
test("a generation handed over without a tool round is completed from its answer before the next one streams", async () => {
  const feed = new TurnFeed(MINE);
  const reading = drain(feed.deltas);
  let reads = 0;
  feed.observe(live({ partial: "Part o" }));
  await tick();
  feed.observe(live({ partial: "More", task: 2 }), () => {
    reads++;
    return "Part one.";
  });
  await tick();
  feed.observe(live({ partial: "More text", task: 2 }), () => "never read");
  await tick();
  feed.complete("More text.");
  feed.end();
  // The tail and the next text go out in one observation, so they arrive together.
  expect(await reading).toEqual(["Part o", "ne.\n\nMore", " text", "."]);
  expect(reads).toBe(1);
  expect(feed.text).toBe("Part one.\n\nMore text.");
});

test("a generation whose tool round was never seen is still completed when the next one starts", () => {
  const feed = new TurnFeed(MINE);
  feed.observe(live({ partial: "Let me lo" }));
  feed.observe(live({ partial: "It is", task: 2 }), () => "Let me look.");
  feed.complete("It is noon.");
  feed.end();
  expect(feed.text).toBe("Let me look.\n\nIt is noon.");
});

test("a next generation first seen in its own tool round does not lend its answer to the one before", () => {
  const feed = new TurnFeed(MINE);
  let reads = 0;
  // The committed answers as the view holds them, each with the generation that wrote it.
  const answers = [
    { task: 1, text: "Let me look." },
    { task: 2, text: "Opening the page." },
  ];
  const answered = (task: TaskId) => {
    reads++;
    return answers.findLast((answer) => answer.task === Number(task))?.text;
  };
  feed.observe(live({ partial: "Let me lo" }));
  feed.observe(live({ tools: call(), task: 2 }), answered);
  feed.complete("It is noon.");
  feed.end();
  expect(feed.text).toBe("Let me look.\n\nOpening the page.\n\nIt is noon.");
  expect(reads).toBe(2);
});

test("a generation none of whose partials was seen is completed in full when the next one starts", async () => {
  const feed = new TurnFeed(MINE);
  const reading = drain(feed.deltas);
  const asked: number[] = [];
  feed.observe(live());
  feed.observe(live({ task: 2 }), (task) => {
    asked.push(Number(task));
    return "Part one.";
  });
  feed.observe(live({ partial: "More", task: 2 }));
  feed.complete("More text.");
  feed.end();
  expect((await reading).join("")).toBe("Part one.\n\nMore text.");
  expect(asked).toEqual([1]);
  expect(feed.text).toBe("Part one.\n\nMore text.");
});
