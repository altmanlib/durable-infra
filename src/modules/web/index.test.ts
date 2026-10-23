import { expect, test } from "bun:test";

import { fauxSetup, testPrompts, toolDeps } from "../../testing/testing.ts";
import { tavilyApiKeyFromEnv, webModule } from "./index.ts";
import type { SearchProvider } from "./search.ts";

const { models, model } = fauxSetup();

test("the search key is optional, trimmed, and absent when blank", () => {
  expect(tavilyApiKeyFromEnv({})).toBeUndefined();
  expect(tavilyApiKeyFromEnv({ TAVILY_API_KEY: "" })).toBeUndefined();
  expect(tavilyApiKeyFromEnv({ TAVILY_API_KEY: "   " })).toBeUndefined();
  expect(tavilyApiKeyFromEnv({ TAVILY_API_KEY: "  tvly-abc \n" })).toBe("tvly-abc");
});

const searching: SearchProvider = { id: "fake", capabilities: { recency: true, domains: true }, search: async () => ({ hits: [] }) };

async function toolNames(options: Parameters<typeof webModule>[0]): Promise<string[]> {
  const module = webModule(options);
  await module.prepare?.({ records: undefined as never, prompts: testPrompts(), models, model });
  const context = { ...toolDeps(), prompts: testPrompts() };
  return (module.contribute(context).tools ?? []).map((tool) => tool.name);
}

test("without a search service there is only web_fetch; with one there is web_search too", async () => {
  expect(await toolNames({})).toEqual(["web_fetch"]);
  expect(await toolNames({ search: searching })).toEqual(["web_fetch", "web_search"]);
  expect(await toolNames({ tavilyApiKey: "tvly-abc" })).toEqual(["web_fetch", "web_search"]);
});

test("a module used before the core prepared it says so instead of failing later", () => {
  expect(() => webModule().contribute({ ...toolDeps(), prompts: testPrompts() })).toThrow("prepared");
});
