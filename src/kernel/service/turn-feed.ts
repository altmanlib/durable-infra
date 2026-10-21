import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LiveState, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { messageText } from "./transcript.ts";

/** One tool call of a turn changing state. */
export type ToolActivity = { readonly callId: string; readonly name: string; readonly status: "running" | "done" };

/** Single-consumer async queue; `take` picks what the next delivery holds. */
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

/** Turns a conversation's live partials and tool calls into one turn's text and tool streams; testable without the Harness. */
export class TurnFeed {
  /** Text increments in order. */
  readonly deltas = new Stream<string>(joined);
  readonly tools = new Stream<ToolActivity>(oneByOne);
  readonly #submissionId: SubmissionId;
  readonly #seen = new Map<string, ToolActivity["status"]>();
  /** Everything that went out so far, across generations. */
  #emitted = "";
  /** Generation whose partials are followed. */
  #round: TaskId | undefined;
  #roundText = "";
  /** A retry rewrote text already sent; later partials are no longer increments. */
  #diverged = false;
  /** The followed generation's answer has been accounted for. */
  #roundDone = false;
  /** Text of each earlier generation that wrote some. */
  #earlier: string[] = [];

  constructor(submissionId: SubmissionId) {
    this.#submissionId = submissionId;
  }

  /** An ended feed, for a turn refused before it started. */
  static closed(): TurnFeed {
    const feed = new TurnFeed(-1 as unknown as SubmissionId);
    feed.end();
    return feed;
  }

  /** Text of every generation joined by `ROUND_SEPARATOR`; a rewritten text appears in its committed form. */
  get text(): string {
    return [...this.#earlier, this.#roundText].filter((text) => text !== "").join(ROUND_SEPARATOR);
  }

  /** How many distinct tool calls this turn has made so far. */
  get toolCalls(): number {
    return this.#seen.size;
  }

  /** Feeds live state (ignored unless this turn's submission is running); `answered` gives a generation's committed answer. */
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
      // Followed generation ended without a seen tool round (`onYield` hand-over); complete it from its own answer.
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
    // Follow from the first frame, so a generation with no seen partials still completes.
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

  /** Completes the streamed text with the committed answer; any difference is appended after a blank line. */
  complete(finalText: string): void {
    // The followed generation already ended in tool calls; this answer belongs to a new one.
    if (this.#roundDone) this.#follow(undefined);
    this.#finishRound(finalText);
  }

  end(): void {
    this.deltas.end();
    this.tools.end();
  }

  /** Follow the partials of `round`; starts over when it is a new generation. */
  #follow(round: TaskId | undefined): void {
    if (round === this.#round) return;
    if (this.#roundText !== "") this.#earlier.push(this.#roundText);
    this.#round = round;
    this.#roundText = "";
    this.#diverged = false;
    this.#roundDone = false;
  }

  /** A generation's committed answer: the tail its partials lacked, or the whole text on a mismatch. */
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
