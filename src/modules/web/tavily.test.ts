import { expect, test } from "bun:test";
import { describeSearchProviderContract, type Scenario, SECRET_KEY } from "../../testing/search-contract.ts";
import { SearchError } from "./search.ts";
import { TavilySearch } from "./tavily.ts";

type Call = { url: string; init: RequestInit };

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** Tavily's own answer for a scenario of the contract test. */
function backend(scenario: Scenario, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    switch (scenario.kind) {
      case "hits":
        return json({
          query: "q",
          results: scenario.hits.map((hit) => ({ title: hit.title, url: hit.url, content: hit.snippet, score: 0.5 })),
          usage: { credits: 1 },
          request_id: "r",
        });
      case "garbage":
        return new Response("<html>gateway</html>", { status: 200 });
      case "status": {
        const status = { auth: 401, quota: 432, rate_limited: 429, server: 500, bad_request: 400 }[scenario.status];
        const headers: Record<string, string> = scenario.retryAfterSeconds === undefined ? {} : { "retry-after": String(scenario.retryAfterSeconds) };
        return new Response(JSON.stringify({ detail: { error: `echoes your query: a private question about nothing in particular 9137 and ${SECRET_KEY}` } }), {
          status,
          headers,
        });
      }
      case "network":
        throw new TypeError("fetch failed");
      case "hang":
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const fail = () => reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail, { once: true });
        });
    }
  }) as typeof fetch;
}

describeSearchProviderContract({
  name: "tavily",
  create: (scenario, { apiKey, timeoutMs }) => new TavilySearch({ apiKey, timeoutMs, fetch: backend(scenario) }),
});

const sent = (calls: Call[]) => JSON.parse(String(calls[0]?.init.body));

test("the request is exactly what the contract maps to: key as a bearer token, fixed switches, nothing extra", async () => {
  const calls: Call[] = [];
  await new TavilySearch({ apiKey: "tvly-test", fetch: backend({ kind: "hits", hits: [] }, calls) }).search({ query: "bun release", maxResults: 4 });
  expect(calls[0]?.url).toBe("https://api.tavily.com/search");
  expect(calls[0]?.init.method).toBe("POST");
  const headers = calls[0]?.init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer tvly-test");
  expect(sent(calls)).toEqual({
    query: "bun release",
    max_results: 4,
    search_depth: "basic",
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_usage: true,
  });
  // The key travels in the header only.
  expect(String(calls[0]?.init.body)).not.toContain("tvly-test");
});

test("recency and domains map to Tavily's own parameters, and are left out when not asked for", async () => {
  const calls: Call[] = [];
  await new TavilySearch({ apiKey: "k", fetch: backend({ kind: "hits", hits: [] }, calls) }).search({
    query: "q",
    maxResults: 5,
    recency: "week",
    includeDomains: ["github.com"],
    excludeDomains: ["example.org", "example.net"],
  });
  expect(sent(calls)).toMatchObject({ time_range: "week", include_domains: ["github.com"], exclude_domains: ["example.org", "example.net"] });

  const plain: Call[] = [];
  await new TavilySearch({ apiKey: "k", fetch: backend({ kind: "hits", hits: [] }, plain) }).search({
    query: "q",
    maxResults: 5,
    includeDomains: [],
    excludeDomains: [],
  });
  expect(Object.keys(sent(plain))).not.toContain("time_range");
  expect(Object.keys(sent(plain))).not.toContain("include_domains");
  expect(Object.keys(sent(plain))).not.toContain("exclude_domains");
});

test("the result count is capped at the contract limit before it reaches Tavily", async () => {
  const calls: Call[] = [];
  await new TavilySearch({ apiKey: "k", fetch: backend({ kind: "hits", hits: [] }, calls) }).search({ query: "q", maxResults: 50 });
  expect(sent(calls).max_results).toBe(10);
});

test("the credits Tavily reports come back as the spend of the search", async () => {
  const response = await new TavilySearch({
    apiKey: "k",
    fetch: backend({ kind: "hits", hits: [{ title: "A", url: "https://example.test/a", snippet: "s" }] }),
  }).search({ query: "q", maxResults: 5 });
  expect(response.spend).toEqual({ credits: 1 });
});

test("snippets come from Tavily's `content`, and the other fields it sends are ignored", async () => {
  const fetchLike = (async () =>
    json({
      results: [{ title: "T", url: "https://example.test/t", content: "the content", raw_content: "ignored", score: 0.9, published_date: "2026-01-01" }],
      answer: "ignored too",
      images: [{ url: "https://example.test/i.png" }],
    })) as unknown as typeof fetch;
  const response = await new TavilySearch({ apiKey: "k", fetch: fetchLike }).search({ query: "q", maxResults: 5 });
  expect(response.hits).toEqual([{ title: "T", url: "https://example.test/t", snippet: "the content" }]);
  expect(response.spend).toBeUndefined();
});

test("a Retry-After given as a date is understood", async () => {
  const later = new Date(Date.now() + 30_000).toUTCString();
  const fetchLike = (async () => new Response("{}", { status: 429, headers: { "retry-after": later } })) as unknown as typeof fetch;
  const error = await new TavilySearch({ apiKey: "k", fetch: fetchLike }).search({ query: "q", maxResults: 5 }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SearchError);
  expect((error as SearchError).retryAfterMs).toBeGreaterThan(20_000);
  expect((error as SearchError).retryAfterMs).toBeLessThanOrEqual(30_000);
});

test("an answer larger than a megabyte is unusable", async () => {
  const fetchLike = (async () => new Response("x".repeat(1024 * 1024 + 10), { status: 200 })) as unknown as typeof fetch;
  const error = await new TavilySearch({ apiKey: "k", fetch: fetchLike }).search({ query: "q", maxResults: 5 }).catch((e: unknown) => e);
  expect((error as SearchError).kind).toBe("unusable");
});
