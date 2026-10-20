import type { Usage } from "@earendil-works/pi-ai";

/**
 * The contract between the `web_search` tool and any search service. Nothing here knows
 * a particular service: types, the error, and the pure functions every provider uses to keep its answers inside it.
 */

export const DEFAULT_MAX_RESULTS = 5;
/** Most hits a call may ask for, whatever a service allows. */
export const MAX_RESULTS_LIMIT = 10;
export const MAX_SNIPPET_CHARS = 500;
const MAX_TITLE_CHARS = 200;

export type Recency = "day" | "week" | "month" | "year";

export type SearchRequest = {
  query: string;
  /** Clamped by the provider to what it and the contract allow. */
  maxResults: number;
  recency?: Recency;
  /** Bare host names such as "github.com", no scheme or path. */
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type SearchHit = {
  title: string;
  /** http or https only. */
  url: string;
  /** At most `MAX_SNIPPET_CHARS`. */
  snippet: string;
};

export type SearchResponse = {
  /** By relevance; may be empty. */
  hits: SearchHit[];
  /** What this search itself cost. Credit-based services report `credits`; token-priced ones `usage`. */
  spend?: { credits?: number; usage?: Usage };
};

/** Options a provider supports beyond the query and the result count. The tool offers the model only these. */
export type SearchCapabilities = { recency: boolean; domains: boolean };

export interface SearchProvider {
  readonly id: string;
  readonly capabilities: SearchCapabilities;
  /** Throws `SearchError` when no answer comes back; never anything else. */
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
}

export type SearchErrorKind =
  /** Cannot connect, or the connection broke; also a cancellation by the caller. */
  | "network"
  | "timeout"
  /** Turned away for now; trying again later may work. */
  | "rate_limited"
  /** Plan or credit limit reached: trying again does not help, a person has to act. */
  | "quota"
  /** Key missing or refused: a configuration problem, a person has to act. */
  | "auth"
  /** Any other error status. */
  | "http"
  /** The service answered, but nothing in it fits the contract. */
  | "unusable";

export class SearchError extends Error {
  constructor(
    readonly kind: SearchErrorKind,
    message: string,
    readonly options: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "SearchError";
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}

/** Kinds where a person, not a retry, has to fix things. */
export const NEEDS_A_PERSON: ReadonlySet<SearchErrorKind> = new Set(["auth", "quota"]);

export function clampMaxResults(requested: number, providerLimit: number = MAX_RESULTS_LIMIT): number {
  const wanted = Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(wanted, MAX_RESULTS_LIMIT, providerLimit));
}

const cut = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
const squeeze = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Turn what a service returned into contract hits: entries that do not fit (no title, an address that is not http or
 * https) are dropped, text is cut to its limits, and no more than `max` are kept. The caller decides what an empty
 * outcome means; see `requireUsable`.
 */
export function cleanHits(raw: readonly { title?: unknown; url?: unknown; snippet?: unknown }[], max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const item of raw) {
    if (hits.length >= max) break;
    if (typeof item.title !== "string" || typeof item.url !== "string") continue;
    const title = squeeze(item.title);
    if (title === "") continue;
    let url: URL;
    try {
      url = new URL(item.url.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    hits.push({
      title: cut(title, MAX_TITLE_CHARS),
      url: url.href,
      snippet: cut(squeeze(typeof item.snippet === "string" ? item.snippet : ""), MAX_SNIPPET_CHARS),
    });
  }
  return hits;
}

/** A service that listed entries of which none fits the contract answered with something unusable; no entries at all is a normal empty answer. */
export function requireUsable(received: number, hits: readonly SearchHit[]): void {
  if (received > 0 && hits.length === 0) throw new SearchError("unusable", "the search service returned results, but none of them could be used");
}

/** Host names the way the contract wants them: lower case, no scheme, path or port; invalid ones and repeats dropped. */
export function normalizeDomains(domains: readonly string[] | undefined): string[] | undefined {
  if (!domains) return undefined;
  const seen = new Set<string>();
  for (const entry of domains) {
    const raw = entry.trim().toLowerCase();
    if (raw === "") continue;
    const host = (() => {
      try {
        return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
      } catch {
        return undefined;
      }
    })();
    if (host && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) seen.add(host);
  }
  return seen.size > 0 ? [...seen] : undefined;
}
