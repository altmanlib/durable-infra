// The executable form of the search contract. A provider's test supplies a way to build
// the provider on a fake backend that behaves as a scenario says; this file checks the rules every provider keeps.
import { describe, expect, test } from "bun:test";
import { MAX_RESULTS_LIMIT, MAX_SNIPPET_CHARS, SearchError, type SearchErrorKind, type SearchProvider } from "../modules/web/search.ts";

export type RawHit = { title?: unknown; url?: unknown; snippet?: unknown };

/** What the fake backend does. Provider-neutral: each provider's test turns it into that service's own response. */
export type Scenario =
  | { kind: "hits"; hits: RawHit[] }
  /** Answers with something other than what the service documents. */
  | { kind: "garbage" }
  | { kind: "status"; status: "auth" | "quota" | "rate_limited" | "server" | "bad_request"; retryAfterSeconds?: number }
  /** Cannot connect. */
  | { kind: "network" }
  /** Never answers; ends only when the caller's signal aborts. */
  | { kind: "hang" };

export type ProviderUnderTest = {
  name: string;
  create(scenario: Scenario, options: { apiKey: string; timeoutMs: number }): SearchProvider;
};

export const SECRET_KEY = "key-that-must-never-leak-4711";
export const PRIVATE_QUERY = "a private question about nothing in particular 9137";

const request = (extra: { maxResults?: number } = {}) => ({ query: PRIVATE_QUERY, maxResults: extra.maxResults ?? 5 });
const good = (n: number): RawHit => ({ title: `Result ${n}`, url: `https://example.test/${n}`, snippet: `About ${n}` });

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the search to fail");
}

async function expectKind(promise: Promise<unknown>, kind: SearchErrorKind): Promise<SearchError> {
  const error = await failure(promise);
  // A provider's own error types must not leak out of it.
  expect(error).toBeInstanceOf(SearchError);
  expect((error as SearchError).kind).toBe(kind);
  return error as SearchError;
}

export function describeSearchProviderContract(subject: ProviderUnderTest): void {
  const make = (scenario: Scenario, timeoutMs = 2000) => subject.create(scenario, { apiKey: SECRET_KEY, timeoutMs });

  describe(`search provider contract: ${subject.name}`, () => {
    test("declares what it supports", () => {
      const { id, capabilities } = make({ kind: "hits", hits: [] });
      expect(id).not.toBe("");
      expect(typeof capabilities.recency).toBe("boolean");
      expect(typeof capabilities.domains).toBe("boolean");
    });

    test("never returns more than was asked for, nor more than the contract allows", async () => {
      const many = Array.from({ length: 30 }, (_, index) => good(index));
      expect((await make({ kind: "hits", hits: many }).search(request({ maxResults: 3 }))).hits).toHaveLength(3);
      expect((await make({ kind: "hits", hits: many }).search(request({ maxResults: 50 }))).hits.length).toBeLessThanOrEqual(MAX_RESULTS_LIMIT);
    });

    test("keeps order, and every hit has a title, an http(s) address and a snippet within its limit", async () => {
      const response = await make({
        kind: "hits",
        hits: [good(1), good(2), { title: "Long", url: "https://example.test/long", snippet: "x".repeat(5000) }],
      }).search(request());
      expect(response.hits.map((hit) => hit.url)).toEqual(["https://example.test/1", "https://example.test/2", "https://example.test/long"]);
      for (const hit of response.hits) {
        expect(hit.title.trim()).not.toBe("");
        expect(hit.url).toMatch(/^https?:\/\//);
        expect(hit.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
      }
    });

    test("drops entries that do not fit instead of failing the search", async () => {
      const response = await make({
        kind: "hits",
        hits: [
          good(1),
          { title: "", url: "https://example.test/no-title", snippet: "x" },
          { title: "Script", url: "javascript:alert(1)", snippet: "x" },
          { title: "File", url: "file:///etc/passwd", snippet: "x" },
          { title: "Ftp", url: "ftp://example.test/x", snippet: "x" },
          { title: "Not a url", url: "not a url", snippet: "x" },
          { title: 42, url: "https://example.test/number-title", snippet: "x" },
          { title: "Missing url", snippet: "x" },
          good(2),
        ],
      }).search(request());
      expect(response.hits.map((hit) => hit.url)).toEqual(["https://example.test/1", "https://example.test/2"]);
    });

    test("an answer in which nothing fits is unusable, not empty", async () => {
      await expectKind(make({ kind: "hits", hits: [{ title: "", url: "javascript:x", snippet: "" }] }).search(request()), "unusable");
    });

    test("no results is a normal answer", async () => {
      expect((await make({ kind: "hits", hits: [] }).search(request())).hits).toEqual([]);
    });

    test("an answer that is not what the service documents is unusable", async () => {
      await expectKind(make({ kind: "garbage" }).search(request()), "unusable");
    });

    test("failures become the right kind of SearchError", async () => {
      await expectKind(make({ kind: "status", status: "auth" }).search(request()), "auth");
      await expectKind(make({ kind: "status", status: "quota" }).search(request()), "quota");
      await expectKind(make({ kind: "status", status: "server" }).search(request()), "http");
      await expectKind(make({ kind: "status", status: "bad_request" }).search(request()), "http");
      await expectKind(make({ kind: "network" }).search(request()), "network");
    });

    test("a rate limit says how long to wait when the service says so", async () => {
      const told = await expectKind(make({ kind: "status", status: "rate_limited", retryAfterSeconds: 7 }).search(request()), "rate_limited");
      expect(told.retryAfterMs).toBe(7000);
      const silent = await expectKind(make({ kind: "status", status: "rate_limited" }).search(request()), "rate_limited");
      expect(silent.retryAfterMs).toBeUndefined();
    });

    test("a service that does not answer in time is a timeout", async () => {
      await expectKind(make({ kind: "hang" }, 60).search(request()), "timeout");
    });

    test("cancelling from outside ends the search as a network error, not a timeout", async () => {
      const before = new AbortController();
      before.abort();
      await expectKind(make({ kind: "hang" }).search(request(), before.signal), "network");
      const during = new AbortController();
      setTimeout(() => during.abort(), 30);
      await expectKind(make({ kind: "hang" }).search(request(), during.signal), "network");
    });

    test("no error carries the key or the query", async () => {
      const scenarios: Scenario[] = [
        { kind: "status", status: "auth" },
        { kind: "status", status: "quota" },
        { kind: "status", status: "rate_limited", retryAfterSeconds: 1 },
        { kind: "status", status: "server" },
        { kind: "status", status: "bad_request" },
        { kind: "garbage" },
        { kind: "network" },
        { kind: "hits", hits: [{ title: "", url: "javascript:x", snippet: "" }] },
      ];
      for (const scenario of scenarios) {
        const error = await failure(make(scenario).search(request()));
        const shown = `${(error as Error).message}\n${String(error)}\n${JSON.stringify(error)}\n${(error as Error).stack ?? ""}`;
        expect([scenario.kind, shown.includes(SECRET_KEY)]).toEqual([scenario.kind, false]);
        expect([scenario.kind, shown.includes(PRIVATE_QUERY)]).toEqual([scenario.kind, false]);
      }
    });
  });
}
