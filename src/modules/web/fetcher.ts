/** One fetched page, reduced to what a model needs. */
export type Page = {
  /** Final address, after redirects. */
  url: string;
  status: number;
  title: string | undefined;
  /** Extracted main text, as Markdown for HTML pages. */
  text: string;
  /** The text was cut at the length limit. */
  truncated: boolean;
  /** A page came back but holds almost no content: it probably builds itself with JavaScript. */
  needsRendering: boolean;
};

export type FetchErrorKind =
  | "invalid_url"
  | "network"
  | "timeout"
  /** An error status other than a refusal. */
  | "http"
  | "too_large"
  | "unsupported_type"
  /** The site turned the request away (403, 429, a bot challenge). Not retried and not escalated. */
  | "refused"
  /** The address is on this machine or a private network (`address-guard.ts`); never requested. */
  | "blocked_address";

export class FetchError extends Error {
  constructor(
    readonly kind: FetchErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/** Gets a page by address. `HttpFetcher` is the first implementation; a browser-backed one can follow. */
export interface PageFetcher {
  /** Throws `FetchError` when the page cannot be read. */
  fetch(url: string, signal?: AbortSignal): Promise<Page>;
}
