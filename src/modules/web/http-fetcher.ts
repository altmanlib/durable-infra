import { checkAddress, type ResolveHost } from "./address-guard.ts";
import { extractContent, extractPlain } from "./extract.ts";
import { FetchError, type Page, type PageFetcher } from "./fetcher.ts";
import { HostGate, Semaphore } from "./limits.ts";

/** Desktop Chrome headers for the retry after a turned-away request; they must agree with each other, so re-check them against current Chrome. */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

export type HttpFetcherOptions = {
  /** Replaces, as a whole, the headers of the second attempt that follows a turned-away plain request. */
  browserHeaders?: Record<string, string>;
  /** Whole call, queueing and every redirect included. */
  timeoutMs?: number;
  /** Largest body read; a bigger one is an error, not a truncation. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Requests running at once, across all callers. */
  maxConcurrent?: number;
  /** Least time between the starts of two requests to the same host. */
  minHostIntervalMs?: number;
  /** Longest text handed back; more is cut and flagged. */
  maxTextChars?: number;
  fetch?: typeof fetch;
  /** Checks each address before a request, including every redirect; throws `blocked_address` for private networks. Tests on 127.0.0.1 pass one that allows all. */
  checkAddress?: (url: URL) => Promise<void>;
  /** How `checkAddress` resolves names when it is the default one. */
  resolveHost?: ResolveHost;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_LIKE = /^text\/|^application\/(json|xml)$|\+(json|xml)$/;

/** True when a site refuses to serve the client it saw: HTTP 403, or a Cloudflare challenge page. */
function turnedAway(response: Response): boolean {
  return response.status === 403 || response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
}

/** Fetches pages with plain HTTP; on a turned-away request, retries once with browser headers. Reads no JavaScript-built content. */
export class HttpFetcher implements PageFetcher {
  readonly #browserHeaders: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #maxRedirects: number;
  readonly #maxTextChars: number;
  readonly #fetch: typeof fetch;
  readonly #checkAddress: (url: URL) => Promise<void>;
  readonly #slots: Semaphore;
  readonly #hosts: HostGate;

  constructor(options: HttpFetcherOptions = {}) {
    this.#browserHeaders = options.browserHeaders ?? { ...BROWSER_HEADERS };
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.#maxRedirects = options.maxRedirects ?? 5;
    this.#maxTextChars = options.maxTextChars ?? 20_000;
    this.#fetch = options.fetch ?? fetch;
    const { resolveHost } = options;
    this.#checkAddress = options.checkAddress ?? ((url) => checkAddress(url, resolveHost));
    this.#slots = new Semaphore(options.maxConcurrent ?? 4);
    this.#hosts = new HostGate(options.minHostIntervalMs ?? 1_000);
  }

  async fetch(url: string, signal?: AbortSignal): Promise<Page> {
    let current = parseUrl(url);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const combined = signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal;
    const stopped = () =>
      deadline.signal.aborted ? new FetchError("timeout", `no answer within ${this.#timeoutMs} ms`) : new FetchError("network", "the request was cancelled");
    try {
      const release = await this.#slots.acquire(combined, stopped);
      try {
        const jar = new Map<string, Map<string, string>>();
        let disguised = false;
        let redirects = 0;
        while (true) {
          await this.#checkAddress(current);
          await this.#hosts.wait(current.host, combined, stopped);
          const response = await this.#request(current, jar, disguised ? this.#browserHeaders : {}, combined, stopped);
          if (!disguised && turnedAway(response)) {
            // A single retry, not counted as a redirect; cookies from the refused answer are dropped.
            await response.body?.cancel();
            disguised = true;
            jar.clear();
            continue;
          }
          if (REDIRECT_STATUSES.has(response.status) && response.headers.has("location")) {
            await response.body?.cancel();
            if (redirects >= this.#maxRedirects) throw new FetchError("http", `more than ${this.#maxRedirects} redirects`, response.status);
            redirects++;
            current = parseUrl(new URL(response.headers.get("location") as string, current).href);
            continue;
          }
          return await this.#page(current, response, combined, stopped);
        }
      } finally {
        release();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(url: URL, jar: Map<string, Map<string, string>>, base: Record<string, string>, signal: AbortSignal, stopped: () => Error): Promise<Response> {
    const headers = new Headers(base);
    const cookies = jar.get(url.host);
    if (cookies && cookies.size > 0) headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    let response: Response;
    try {
      response = await this.#fetch(url, { method: "GET", headers, redirect: "manual", signal });
    } catch (error) {
      if (signal.aborted) throw stopped();
      const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
      throw new FetchError("network", `could not connect to ${url.host}${code ? ` (${code})` : ""}`);
    }
    // Only for the redirect chain of this call: a later call starts with no cookies.
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair = ""] = line.split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const names = jar.get(url.host) ?? new Map<string, string>();
      names.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      jar.set(url.host, names);
    }
    return response;
  }

  async #page(url: URL, response: Response, signal: AbortSignal, stopped: () => Error): Promise<Page> {
    const { status } = response;
    if (status === 403 || status === 429 || response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
      await response.body?.cancel();
      throw new FetchError("refused", `${url.host} refused the request (HTTP ${status})`, status);
    }
    if (status >= 400) {
      await response.body?.cancel();
      throw new FetchError("http", `${url.host} answered HTTP ${status}`, status);
    }

    const contentType = response.headers.get("content-type");
    const media = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
    const isHtml = media === "" || HTML_TYPES.has(media);
    if (!isHtml && !TEXT_LIKE.test(media)) {
      await response.body?.cancel();
      throw new FetchError("unsupported_type", `the page is ${media}, which cannot be read as text`, status);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.#maxBytes) {
      await response.body?.cancel();
      throw new FetchError("too_large", `the page is larger than ${this.#maxBytes} bytes`, status);
    }

    const body = decode(await this.#read(response, signal, stopped), contentType, isHtml);
    const extracted = isHtml ? extractContent(body, url.href) : extractPlain(body);
    const truncated = extracted.text.length > this.#maxTextChars;
    return {
      url: url.href,
      status,
      title: extracted.title,
      text: truncated ? extracted.text.slice(0, this.#maxTextChars) : extracted.text,
      truncated,
      needsRendering: extracted.needsRendering,
    };
  }

  async #read(response: Response, signal: AbortSignal, stopped: () => Error): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.#maxBytes) throw new FetchError("too_large", `the page is larger than ${this.#maxBytes} bytes`, response.status);
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof FetchError) throw error;
      throw signal.aborted ? stopped() : new FetchError("network", "the connection broke while reading the page");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new FetchError("invalid_url", `"${value}" is not a valid address; it needs to start with http:// or https://`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError("invalid_url", `only http and https addresses can be read, not ${url.protocol}`);
  }
  return url;
}

/** Charset from the response header, else from a `<meta>` in the first bytes of HTML, else UTF-8. */
function decode(bytes: Uint8Array, contentType: string | null, isHtml: boolean): string {
  let label = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (!label && isHtml) label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 2048)))?.[1];
  try {
    return new TextDecoder((label ?? "utf-8") as "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
