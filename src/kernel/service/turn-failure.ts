/** How long one model request may wait for headers/connect before it fails; overridable via `settings.stream.timeoutMs`. */
export const DEFAULT_STREAM_TIMEOUT_MS = 60_000;

const DETAIL_MAX = 300;

const TIMEOUT = /timed?\s*out|timeout|APIConnectionTimeoutError|ConnectTimeoutError|headers?\s*timed\s*out|ETIMEDOUT/i;
const UNREACHABLE =
  /connection\s*refused|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNRESET|socket hang up|network\s*error|other side closed|upstream\s*connect|could not connect/i;

/** A short form of `TurnFailed.detail` for logs; undefined when there is nothing useful to show. */
export function turnFailureDetail(detail: unknown, max = DETAIL_MAX): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  const text = typeof detail === "string" ? detail : detail instanceof Error ? detail.message : String(detail);
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Maps an unanswered settlement to a stable reason channels can switch on.
 * Timeout and connection failures become `provider_timeout` / `provider_unreachable`; other reasons pass through.
 */
export function classifyTurnFailure(reason: string, detail?: unknown): string {
  if (reason !== "model_error" && reason !== "interrupted") return reason;
  const text = turnFailureDetail(detail, Number.POSITIVE_INFINITY) ?? "";
  if (TIMEOUT.test(text)) return "provider_timeout";
  if (UNREACHABLE.test(text)) return "provider_unreachable";
  return reason;
}
