import type { Usage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { PromptSource } from "../../kernel/prompts.ts";

/** The model call behind an answer failed or gave nothing usable. Carries the spend, which still counts. */
export class SummaryError extends Error {
  constructor(
    message: string,
    readonly usage?: Usage,
  ) {
    super(message);
    this.name = "SummaryError";
  }
}

export type Summary = { text: string; usage: Usage };

/** Answers a question from one page, so only the answer reaches the main model (docs/design/2026-10-06-model-delegation.md §4.2). */
export interface PageSummarizer {
  /** `document` is the page already wrapped in its `<web_page>` tag. Throws `SummaryError` when no answer comes back. */
  answer(document: string, question: string, signal?: AbortSignal): Promise<Summary>;
}

/** One model call without tools, so text in the page cannot drive any side effect from here. */
export class ModelSummarizer implements PageSummarizer {
  readonly #models: Models;
  readonly #model: { provider: string; modelId: string };
  readonly #prompts: PromptSource;

  constructor(models: Models, model: { provider: string; modelId: string }, prompts: PromptSource) {
    this.#models = models;
    this.#model = model;
    this.#prompts = prompts;
  }

  async answer(document: string, question: string, signal?: AbortSignal): Promise<Summary> {
    const model = this.#models.getModel(this.#model.provider, this.#model.modelId);
    if (!model) throw new Error(`summary model ${this.#model.provider}/${this.#model.modelId} is not registered`);
    const context = {
      systemPrompt: this.#prompts.get("summary.instructions"),
      messages: [{ role: "user" as const, content: `${document}\n\n<question>\n${question}\n</question>`, timestamp: Date.now() }],
    };
    let message: Awaited<ReturnType<Models["completeSimple"]>>;
    try {
      message = await this.#models.completeSimple(model, context, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SummaryError(error instanceof Error ? error.message : String(error));
    }
    if (message.stopReason === "aborted" && signal?.aborted) throw signal.reason;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new SummaryError(message.errorMessage || `the model call ended with "${message.stopReason}"`, message.usage);
    }
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    if (text === "") throw new SummaryError("the model returned an empty answer", message.usage);
    return { text: message.stopReason === "length" ? `${text}\n[Answer cut short at the length limit.]` : text, usage: message.usage };
  }
}
