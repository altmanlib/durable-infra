import { clampMaxResults, cleanHits, requireUsable, SearchError, type SearchProvider, type SearchRequest, type SearchResponse } from "./search.ts";

const ENDPOINT = "https://api.tavily.com/search";
/** The answer is read only up to this size. */
const MAX_BODY_BYTES = 1024 * 1024;
const TAVILY_MAX_RESULTS = 20;

export type TavilyOptions = {
  apiKey: string;
  timeoutMs?: number;
  endpoint?: string;
  fetch?: typeof fetch;
};

/** Seconds, or an HTTP date, to milliseconds; undefined when absent or not understood. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Tavily search (https://docs.tavily.com/documentation/api-reference/endpoint/search) at `basic` depth, one credit; its own answer, raw content and images are off. */
export class TavilySearch implements SearchProvider {
  readonly id = "tavily";
  readonly capabilities = { recency: true, domains: true };
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: TavilyOptions) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#endpoint = options.endpoint ?? ENDPOINT;
    this.#fetch = options.fetch ?? fetch;
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const max = clampMaxResults(request.maxResults, TAVILY_MAX_RESULTS);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const combined = signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal;
    const stopped = () =>
      deadline.signal.aborted
        ? new SearchError("timeout", `Tavily did not answer within ${this.#timeoutMs} ms`)
        : new SearchError("network", "the search was cancelled");
    try {
      const response = await this.#request(request, max, combined, stopped);
      return await this.#parse(response, max, combined, stopped);
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(request: SearchRequest, max: number, signal: AbortSignal, stopped: () => SearchError): Promise<Response> {
    const body = {
      query: request.query,
      max_results: max,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: true,
      ...(request.recency ? { time_range: request.recency } : {}),
      ...(request.includeDomains?.length ? { include_domains: request.includeDomains.slice(0, 300) } : {}),
      ...(request.excludeDomains?.length ? { exclude_domains: request.excludeDomains.slice(0, 150) } : {}),
    };
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      if (signal.aborted) throw stopped();
      throw new SearchError("network", "could not reach Tavily");
    }
    return response;
  }

  async #parse(response: Response, max: number, signal: AbortSignal, stopped: () => SearchError): Promise<SearchResponse> {
    const { status } = response;
    if (status === 401) throw await this.#reject(response, "auth", "Tavily refused the API key (HTTP 401)");
    if (status === 432 || status === 433)
      throw await this.#reject(response, "quota", `Tavily reports that the plan or credit limit is reached (HTTP ${status})`);
    if (status === 429)
      throw await this.#reject(response, "rate_limited", "Tavily is limiting requests (HTTP 429)", {
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      });
    if (status < 200 || status >= 300) throw await this.#reject(response, "http", `Tavily answered HTTP ${status}`);

    const text = await this.#read(response, signal, stopped);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new SearchError("unusable", "Tavily did not answer with JSON");
    }
    const results = (data as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) throw new SearchError("unusable", "Tavily's answer has no results list");
    const hits = cleanHits(
      results.map((entry: { title?: unknown; url?: unknown; content?: unknown } | null) => ({ title: entry?.title, url: entry?.url, snippet: entry?.content })),
      max,
    );
    requireUsable(results.length, hits);
    const credits = (data as { usage?: { credits?: unknown } }).usage?.credits;
    return { hits, ...(typeof credits === "number" ? { spend: { credits } } : {}) };
  }

  /** Drops the body (it may repeat the query) and returns the error; the message is ours alone. */
  async #reject(
    response: Response,
    kind: "auth" | "quota" | "rate_limited" | "http",
    message: string,
    options: { retryAfterMs?: number | undefined } = {},
  ): Promise<SearchError> {
    await response.body?.cancel().catch(() => {});
    return new SearchError(kind, message, options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs });
  }

  async #read(response: Response, signal: AbortSignal, stopped: () => SearchError): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) throw new SearchError("unusable", "Tavily's answer is larger than expected");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof SearchError) throw error;
      throw signal.aborted ? stopped() : new SearchError("network", "the connection to Tavily broke while reading the answer");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
}
