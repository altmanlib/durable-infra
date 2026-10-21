import type { Module } from "../../kernel/module.ts";
import { log } from "../../platform/log.ts";
import type { PageFetcher } from "./fetcher.ts";
import { HttpFetcher } from "./http-fetcher.ts";
import { WEB_PROMPTS } from "./prompts.ts";
import type { SearchProvider } from "./search.ts";
import { ModelSummarizer, type PageSummarizer } from "./summarizer.ts";
import { TavilySearch } from "./tavily.ts";
import { webContentSection } from "./web-content.ts";
import { createWebFetchTool, WEB_FETCH } from "./web-fetch.ts";
import { createWebSearchTool, WEB_SEARCH } from "./web-search.ts";

export { WEB_PROMPTS } from "./prompts.ts";

export type WebOptions = {
  /** Key of the Tavily search service. Without a search provider there is no `web_search` tool. */
  tavilyApiKey?: string;
  /** Another search service than Tavily. */
  search?: SearchProvider;
  /** How pages are fetched; by default over HTTP, refusing this machine and private networks. */
  pages?: PageFetcher;
  /** Answers `web_fetch` questions from a page; by default one call of the conversations' model, without tools. */
  summarizer?: PageSummarizer;
};

/** `TAVILY_API_KEY`, trimmed; absent when blank. */
export function tavilyApiKeyFromEnv(env: Record<string, string | undefined>): string | undefined {
  const key = env.TAVILY_API_KEY?.trim();
  return key ? key : undefined;
}

/** `web_fetch` and, when a search service is given, `web_search`; both are read-only, so shared conversations have them. */
export function webModule(options: WebOptions = {}): Module {
  const pages = options.pages ?? new HttpFetcher();
  const search = options.search ?? (options.tavilyApiKey ? new TavilySearch({ apiKey: options.tavilyApiKey }) : undefined);
  let summarizer = options.summarizer;
  return {
    name: "web",
    prompts: WEB_PROMPTS,
    toolSpecs: [{ name: WEB_FETCH }, search ? { name: WEB_SEARCH } : { name: WEB_SEARCH, off: true, note: "needs a search service: set TAVILY_API_KEY" }],
    async prepare({ models, model, prompts }) {
      // Page answers use the main model until real use shows a separate one is worth configuring.
      summarizer ??= new ModelSummarizer(models, model, prompts);
      log.info("search.provider", { provider: search?.id ?? "none" });
      return [];
    },
    contribute: ({ prompts }) => {
      if (!summarizer) throw new Error("the web module was used before it was prepared");
      return {
        tools: [createWebFetchTool({ pages, summarizer, prompts }), ...(search ? [createWebSearchTool({ search, prompts })] : [])],
        sections: [webContentSection(prompts)],
      };
    },
  };
}
