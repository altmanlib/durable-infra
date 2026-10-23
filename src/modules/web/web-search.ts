import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import type { PromptSource } from "../../kernel/prompts.ts";
import { keyForLog } from "../../kernel/service/conversation-key.ts";
import { log } from "../../platform/log.ts";
import { Semaphore } from "./limits.ts";
import {
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_LIMIT,
  NEEDS_A_PERSON,
  normalizeDomains,
  type Recency,
  type SearchError,
  SearchError as SearchFailure,
  type SearchHit,
  type SearchProvider,
  type SearchRequest,
} from "./search.ts";

export const WEB_SEARCH = "web_search";

/** Searches that may run at once: each one costs money. */
const MAX_CONCURRENT = 4;
const MIN_QUERY_CHARS = 2;

const attribute = (value: string) => value.replace(/"/g, "&quot;").replace(/[\r\n]+/g, " ");
/** Text from a search result must not be able to close the tag that marks it as outside content. */
const defang = (text: string) => text.replace(/<\/web_results/gi, "<\\/web_results");

export function formatSearchResults(query: string, hits: readonly SearchHit[], reminder: string): string {
  if (hits.length === 0) return `<web_results query="${attribute(query)}">\nNo results were found.\n</web_results>`;
  const entries = hits.map((hit, index) =>
    [`${index + 1}. ${defang(hit.title)}`, `   ${defang(hit.url)}`, ...(hit.snippet === "" ? [] : [`   ${defang(hit.snippet)}`])].join("\n"),
  );
  return [`<web_results query="${attribute(query)}">`, ...entries, "</web_results>", reminder].join("\n");
}

function failure(error: SearchError): string {
  const seconds = error.retryAfterMs === undefined ? "" : ` (the service suggests waiting about ${Math.ceil(error.retryAfterMs / 1000)} seconds)`;
  const advice = NEEDS_A_PERSON.has(error.kind)
    ? "Search is not available right now because of a problem with the search service's account. Tell the user; do not try again."
    : error.kind === "rate_limited"
      ? `The search service is limiting requests. This may work if tried again in a little while${seconds}.`
      : error.kind === "network" || error.kind === "timeout"
        ? "This may work if tried again later."
        : "Trying again once with different wording may help.";
  return `The search failed: ${error.message}. ${advice}`;
}

/** The parameters the model sees: the ones every provider has, plus the options this provider supports. */
function parameters(search: SearchProvider, prompts: PromptSource) {
  const { recency, domains } = search.capabilities;
  const days: Recency[] = ["day", "week", "month", "year"];
  return Type.Object({
    query: Type.String({ minLength: MIN_QUERY_CHARS, description: prompts.get("tool.web_search.query") }),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS_LIMIT, description: prompts.get("tool.web_search.max_results") })),
    ...(recency
      ? {
          recency: Type.Optional(
            Type.Union(
              days.map((value) => Type.Literal(value)),
              { description: prompts.get("tool.web_search.recency") },
            ),
          ),
        }
      : {}),
    ...(domains
      ? {
          include_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: prompts.get("tool.web_search.include_domains") })),
          exclude_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: prompts.get("tool.web_search.exclude_domains") })),
        }
      : {}),
  });
}

const text = (value: string) => [{ type: "text" as const, text: value }];
const coded = (code: string, body: string, extra: Record<string, unknown> = {}) => ({ output: text(body), details: { code }, ...extra });
const failed = (code: string, body: string) => ({ isError: true as const, ...coded(code, body) });

export function createWebSearchTool(deps: { search: SearchProvider; prompts: PromptSource }) {
  const slots = new Semaphore(MAX_CONCURRENT);
  return defineTool({
    name: WEB_SEARCH,
    description: deps.prompts.get("tool.web_search.description"),
    parameters: parameters(deps.search, deps.prompts),
    // A repeated search only costs one more search.
    replay: "safe",
    execute: async (args, api, context) => {
      const started = Date.now();
      // Logged so a search can be traced to its conversation.
      const key = await keyForLog(api, context);
      const provider = deps.search.id;
      const query = args.query.trim();
      if (query.length < MIN_QUERY_CHARS) return failed("query_too_short", "The query is too short. Say what to look for in a few words.");

      const { recency, domains } = deps.search.capabilities;
      const asked = args as { recency?: Recency; include_domains?: string[]; exclude_domains?: string[] };
      const request: SearchRequest = {
        query,
        maxResults: args.max_results ?? DEFAULT_MAX_RESULTS,
        ...(recency && asked.recency ? { recency: asked.recency } : {}),
        ...(domains && normalizeDomains(asked.include_domains) ? { includeDomains: normalizeDomains(asked.include_domains) as string[] } : {}),
        ...(domains && normalizeDomains(asked.exclude_domains) ? { excludeDomains: normalizeDomains(asked.exclude_domains) as string[] } : {}),
      };

      const signal = context.abortSignal ?? new AbortController().signal;
      let release: (() => void) | undefined;
      try {
        release = await slots.acquire(signal, () => new SearchFailure("network", "the search was cancelled"));
        const response = await deps.search.search(request, signal);
        log.info("web_search.done", {
          key,
          provider,
          queryChars: query.length,
          results: response.hits.length,
          credits: response.spend?.credits,
          ms: Date.now() - started,
        });
        return coded("searched", formatSearchResults(query, response.hits, deps.prompts.get("tool.web_search.reminder")), {
          ...(response.spend?.usage ? { usage: response.spend.usage } : {}),
        });
      } catch (error) {
        if (!(error instanceof SearchFailure)) throw error;
        // A key or an account that needs a person is worth an error line; a busy service is not.
        (NEEDS_A_PERSON.has(error.kind) ? log.error : log.warn)("web_search.failed", {
          key,
          provider,
          kind: error.kind,
          queryChars: query.length,
          ms: Date.now() - started,
        });
        return failed(error.kind, failure(error));
      } finally {
        release?.();
      }
    },
  });
}
