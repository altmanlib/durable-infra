import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { PromptSource } from "../../kernel/prompts.ts";
import { keyForLog } from "../../kernel/service/conversation-key.ts";
import { log } from "../../platform/log.ts";
import { FetchError, type Page, type PageFetcher } from "./fetcher.ts";
import { type PageSummarizer, SummaryError } from "./summarizer.ts";

export const WEB_FETCH = "web_fetch";

const attribute = (value: string) => value.replace(/"/g, "&quot;").replace(/[\r\n]+/g, " ");
/** Page text must not be able to close the tag that marks it as outside content. */
const defang = (text: string) => text.replace(/<\/web_page/gi, "<\\/web_page");

function openTag(page: Page, mode?: "answer"): string {
  return `<web_page url="${attribute(page.url)}"${page.title ? ` title="${attribute(page.title)}"` : ""}${mode ? ` mode="${mode}"` : ""}>`;
}

export function formatPage(page: Page, limit: number): string {
  const lines = [openTag(page)];
  if (page.text !== "") lines.push(defang(page.text));
  if (page.truncated) lines.push(`[Content cut at ${limit} characters.]`);
  lines.push("</web_page>");
  if (page.needsRendering) {
    lines.push(
      "This page builds its content with JavaScript, which this tool cannot run, so little or nothing could be read from it. Say so to the user instead of guessing what the page contains.",
    );
  }
  return lines.join("\n");
}

/** An answer drawn from the page stays inside the tag: it may still repeat text planted in the page. */
export function formatAnswer(page: Page, answer: string, limit: number): string {
  const lines = [openTag(page, "answer"), defang(answer)];
  if (page.truncated) lines.push(`[Answered from the first ${limit} characters of the page only.]`);
  lines.push("</web_page>");
  return lines.join("\n");
}

const RETRYABLE = new Set(["network", "timeout"]);

function failure(error: FetchError): string {
  const advice = RETRYABLE.has(error.kind)
    ? "This may work if tried again later."
    : error.kind === "refused"
      ? "Tell the user the site turned the request away; do not try to get around it."
      : error.kind === "blocked_address"
        ? "Addresses on this machine or a private network cannot be read; tell the user, and do not try another such address."
        : "Trying again will not help.";
  return `Could not read the page: ${error.message}. ${advice}`;
}

/** Host of an address for the log; the address itself may carry secrets in its path or query. */
const hostOf = (address: string): string => {
  try {
    return new URL(address).host;
  } catch {
    return "invalid";
  }
};

const text = (value: string) => [{ type: "text" as const, text: value }];
const coded = (code: string, body: string, extra: Record<string, unknown> = {}) => ({ output: text(body), details: { code }, ...extra });
const failed = (code: string, body: string, extra: Record<string, unknown> = {}) => ({ isError: true as const, ...coded(code, body, extra) });

export function createWebFetchTool(deps: { pages: PageFetcher; summarizer: PageSummarizer; prompts: PromptSource; textLimit?: number }) {
  const limit = deps.textLimit ?? 20_000;
  return defineTool({
    name: WEB_FETCH,
    description: deps.prompts.get("tool.web_fetch.description"),
    parameters: Type.Object({
      url: Type.String({ description: deps.prompts.get("tool.web_fetch.url") }),
      prompt: Type.Optional(Type.String({ description: deps.prompts.get("tool.web_fetch.prompt") })),
    }),
    // Reading changes nothing and the answer call has no tools, so an interrupted call may simply run again.
    replay: "safe",
    execute: async (args, api, context) => {
      const started = Date.now();
      // In the log lines, so a change that follows a read can be traced to the conversation that made it.
      const key = await keyForLog(api, context);
      let page: Page;
      try {
        page = await deps.pages.fetch(args.url, context.abortSignal);
      } catch (error) {
        if (error instanceof FetchError) {
          log.warn("web_fetch.failed", { key, host: hostOf(args.url), kind: error.kind, status: error.status, ms: Date.now() - started });
          return failed(error.kind, failure(error));
        }
        throw error;
      }
      const question = args.prompt?.trim();
      const fields = {
        key,
        host: hostOf(page.url),
        status: page.status,
        chars: page.text.length,
        truncated: page.truncated,
        needsRendering: page.needsRendering,
      };
      // Nothing to answer from: the page text already says why.
      if (!question || page.text === "") {
        log.info("web_fetch.done", { ...fields, answered: false, ms: Date.now() - started });
        return coded("fetched", formatPage(page, limit));
      }
      try {
        const summary = await deps.summarizer.answer(formatPage(page, limit), question, context.abortSignal);
        log.info("web_fetch.done", { ...fields, answered: true, answerChars: summary.text.length, ms: Date.now() - started });
        return coded("answered", formatAnswer(page, summary.text, limit), { usage: summary.usage });
      } catch (error) {
        if (!(error instanceof SummaryError)) throw error;
        log.warn("web_fetch.answer_failed", { ...fields, ms: Date.now() - started }, error);
        // No quiet fallback to the page text: the answer step exists to keep that text out of the main context.
        return failed(
          "answer_failed",
          `The page was read, but answering from it failed: ${error.message}. Try again, or call ${WEB_FETCH} without prompt to get the page text.`,
          error.usage ? { usage: error.usage } : {},
        );
      }
    },
  });
}
