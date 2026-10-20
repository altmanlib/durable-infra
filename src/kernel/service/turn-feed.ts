import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LiveState, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { messageText } from "./transcript.ts";

/** One tool call of a turn changing state. */
export type ToolActivity = { readonly callId: string; readonly name: string; readonly status: "running" | "done" };

/** Single-consumer async queue; `take` removes what the next delivery consists of from the pending items. */
export class Stream<T> implements AsyncIterable<T> {
  #pending: T[] = [];
  #ended = false;
  #wake: (() => void) | undefined;

  constructor(private readonly take: (pending: T[]) => T) {}

  push(item: T): void {
    if (this.#ended) return;
    this.#pending.push(item);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.#pending.length > 0) {
        yield this.take(this.#pending);
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}

/** Text chunks that arrive faster than they are read are joined into one delivery. */
const joined = (pending: string[]): string => pending.splice(0).join("");
/** Tool activity is delivered one change at a time. */
const oneByOne = (pending: ToolActivity[]): ToolActivity => pending.shift() as ToolActivity;

/** Between the text of one generation and the next, as between the text before a tool call and the text after it. */
export const ROUND_SEPARATOR = "\n\n";

/**
 * Turns what a conversation publishes while it runs (a cumulative partial answer and the tool calls of the round)
 * into the streams of one turn: text increments and tool activity. Knows nothing about the Harness, so it can be
 * driven by hand.
 *
 * A partial is cumulative within one generation task, which `live.run.taskId` names: a retry is another attempt of the
 * same task and starts its text over, while after a tool round the Harness hands the run over to a new generation task
 * (`handOver`), whose text is new. So text of a new task follows what went out after `ROUND_SEPARATOR`, and only a
 * partial of the same task that does not continue what went out is a rewrite. When a generation ends in tool calls,
 * the commit that opens the tool round (`live.tools`) also adds its answer, whose text completes the last partial, as
 * the committed final answer does at the end (`complete`). A generation that hands over without a tool round seen (an
 * `onYield` continuation) is completed the same way from its own answer when the next one shows up.
 */
export class TurnFeed {
  /** Text increments in order. */
  readonly deltas = new Stream<string>(joined);
  readonly tools = new Stream<ToolActivity>(oneByOne);
  readonly #submissionId: SubmissionId;
  readonly #seen = new Map<string, ToolActivity["status"]>();
  /** Everything that went out so far, across generations. */
  #emitted = "";
  /** The generation whose partials are being followed, and the part of `#emitted` its partials produced. */
  #round: TaskId | undefined;
  #roundText = "";
  /** A retry rewrote text of this generation that had already gone out; its later partials are not increments of it. */
  #diverged = false;
  /** The followed generation ended in tool calls and its answer has been accounted for. */
  #roundDone = false;
  /** The text of each earlier generation that wrote some, as it ended (committed, or its last partial). */
  #earlier: string[] = [];

  constructor(submissionId: SubmissionId) {
    this.#submissionId = submissionId;
  }

  /** A feed that has already ended and will never carry anything, for a turn that was refused before it started. */
  static closed(): TurnFeed {
    const feed = new TurnFeed(-1 as unknown as SubmissionId);
    feed.end();
    return feed;
  }

  /**
   * The text of every generation so far, joined by `ROUND_SEPARATOR`, the final answer last once `complete` has run:
   * what streamed, but with a rewritten text in its committed form only.
   */
  get text(): string {
    return [...this.#earlier, this.#roundText].filter((text) => text !== "").join(ROUND_SEPARATOR);
  }

  /** How many distinct tool calls this turn has made so far. */
  get toolCalls(): number {
    return this.#seen.size;
  }

  /**
   * Feed the live state of the conversation; it is ignored unless this turn's submission is the one running.
   * `answered` reads the text of the newest answer generation `task` committed (by `byTaskId`, not the newest of all);
   * it is asked at most once per generation, when its tool round opens or the next generation shows up first.
   */
  observe(live: LiveState | undefined, answered?: (task: TaskId) => string | undefined): void {
    // An earlier queued run may still be streaming.
    if (!live?.run?.inputs.includes(this.#submissionId)) return;
    for (const slot of live.tools ?? []) {
      if (slot.status === "pending" || this.#seen.get(slot.callId) === slot.status) continue;
      this.#seen.set(slot.callId, slot.status);
      this.tools.push({ callId: slot.callId, name: slot.name, status: slot.status });
    }
    const toolRound = live.tools !== undefined && live.tools.length > 0;
    if (this.#round !== undefined && live.run.taskId !== this.#round && !this.#roundDone) {
      // The followed generation ended without a tool round seen here, as when an `onYield` continuation hands the run
      // over in the commit of its answer. Its own answer completes it, even when the new one has committed one too.
      this.#finishRound(answered?.(this.#round) ?? "");
    }
    if (toolRound) {
      // The generation that called the tools still holds the run; its answer is committed.
      this.#follow(live.run.taskId);
      if (!this.#roundDone) {
        this.#finishRound(answered?.(live.run.taskId) ?? "");
        this.#roundDone = true;
      }
      return;
    }
    // Followed from its first frame, so a generation none of whose partials was seen is still completed when it ends.
    this.#follow(live.run.taskId);
    const partial = messageText(live.generation?.message as AssistantMessage | undefined);
    if (!partial) return;
    if (this.#diverged || this.#roundDone) return;
    if (partial.startsWith(this.#roundText)) {
      this.#pushRound(partial.slice(this.#roundText.length));
      this.#roundText = partial;
    } else {
      this.#diverged = true;
    }
  }

  /**
   * The committed answer completes what the partials of its generation showed; if it differs (a rewrite, or no partial
   * of it was seen), it follows in full after a blank line.
   */
  complete(finalText: string): void {
    // The followed generation ended in tool calls, so the answer is of one none of whose partials were seen.
    if (this.#roundDone) this.#follow(undefined);
    this.#finishRound(finalText);
  }

  end(): void {
    this.deltas.end();
    this.tools.end();
  }

  /** Follow the partials of generation `round` (undefined when it is unknown), starting over when it is a new one. */
  #follow(round: TaskId | undefined): void {
    if (round === this.#round) return;
    if (this.#roundText !== "") this.#earlier.push(this.#roundText);
    this.#round = round;
    this.#roundText = "";
    this.#diverged = false;
    this.#roundDone = false;
  }

  /** A generation's committed answer: the tail its partials lacked, or the whole text when they showed something else. */
  #finishRound(text: string): void {
    if (text === "") return;
    if (!this.#diverged && !this.#roundDone && this.#roundText !== "" && text.startsWith(this.#roundText)) {
      this.#pushRound(text.slice(this.#roundText.length));
    } else {
      this.#pushText(this.#emitted === "" ? text : `${ROUND_SEPARATOR}${text}`);
    }
    this.#roundText = text;
  }

  /** Text of the followed generation; its first text goes after a separator when an earlier one wrote some. */
  #pushRound(chunk: string): void {
    if (chunk === "") return;
    const first = this.#roundText === "" && this.#emitted !== "";
    this.#pushText(first ? `${ROUND_SEPARATOR}${chunk}` : chunk);
  }

  #pushText(chunk: string): void {
    if (chunk === "") return;
    this.deltas.push(chunk);
    this.#emitted += chunk;
  }
}
