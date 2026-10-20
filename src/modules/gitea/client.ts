/**
 * The bot account's door to Gitea: the repository check and the issue calls,
 * written like the search client (`core/web/tavily.ts`). The token goes only in the request header; redirects are not followed, so it never
 * reaches another address; what Gitea says on a failure is kept as `detail` for the log, never for the model.
 */

/** A repository as the issue tool needs it. */
export type GiteaRepo = {
  /** `owner/name` in Gitea's own case. */
  fullName: string;
  archived: boolean;
  /** Gitea's own issues are on: not off, and not an external tracker. */
  internalTracker: boolean;
};

export type GiteaIssue = { number: number; url: string };

export type GiteaIssueState = "open" | "closed";

/** One issue as the list shows it: no body. `author` is the login of who opened it, `""` when Gitea names nobody. */
export type GiteaIssueSummary = {
  number: number;
  title: string;
  state: GiteaIssueState;
  url: string;
  author: string;
  comments: number;
  updatedAt: string;
};

/** One issue read whole: the summary, its body and its labels. */
export type GiteaIssueDetail = GiteaIssueSummary & { body: string; labels: string[]; createdAt: string };

export type GiteaComment = { id: number; url: string };

/** The changes an edit may make; a field left out stays as it is. */
export type GiteaIssuePatch = { title?: string; body?: string; state?: GiteaIssueState };

export type GiteaClient = {
  /** `missing`: no such repository, or the bot cannot see it (404); `moved`: renamed (3xx). Anything else throws `GiteaError`. */
  repo(owner: string, name: string, signal?: AbortSignal): Promise<GiteaRepo | "missing" | "moved">;
  /** The new issue's number and address; anything but 201 throws `GiteaError`. */
  createIssue(owner: string, name: string, issue: { title: string; body: string }, signal?: AbortSignal): Promise<GiteaIssue>;
  /** The repository's issues of one state, newest first, at most `limit`; pull requests are not listed. Anything but 200 throws `GiteaError`. */
  listIssues(owner: string, name: string, query: { state: GiteaIssueState | "all"; limit: number }, signal?: AbortSignal): Promise<GiteaIssueSummary[]>;
  /** One issue read whole; `missing`: no such issue, or no such repository (404). Anything else throws `GiteaError`. */
  getIssue(owner: string, name: string, index: number, signal?: AbortSignal): Promise<GiteaIssueDetail | "missing">;
  /** The new comment's id and address; anything but 201 throws `GiteaError`. */
  createComment(owner: string, name: string, index: number, comment: { body: string }, signal?: AbortSignal): Promise<GiteaComment>;
  /** The issue as the edit left it; anything but 200 throws `GiteaError`. */
  editIssue(owner: string, name: string, index: number, patch: GiteaIssuePatch, signal?: AbortSignal): Promise<GiteaIssueSummary>;
};

/**
 * `network`: not reached, or the connection broke; `timeout`; `status`: an HTTP status not expected, in `status`;
 * `unusable`: a success whose answer cannot be read.
 */
export type GiteaErrorKind = "network" | "timeout" | "status" | "unusable";

export class GiteaError extends Error {
  constructor(
    readonly kind: GiteaErrorKind,
    message: string,
    readonly status?: number,
    /** Gitea's own `message`, cut short, for the log only. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GiteaError";
  }
}

export type GiteaHttpClientOptions = {
  /** The root address, without `/api/v1` or a trailing slash. */
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export const GITEA_TIMEOUT_MS = 15_000;
/** An answer is read only up to this size. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DETAIL_CHARS = 200;

export class GiteaHttpClient implements GiteaClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: GiteaHttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? GITEA_TIMEOUT_MS;
    this.#fetch = options.fetch ?? fetch;
  }

  async repo(owner: string, name: string, signal?: AbortSignal): Promise<GiteaRepo | "missing" | "moved"> {
    return this.#call("GET", repoPath(owner, name), undefined, signal, async (response, read) => {
      if (response.status === 404) return "missing";
      if (response.status >= 300 && response.status < 400) return "moved";
      if (response.status !== 200) throw await this.#reject(response, read);
      const data = parse(await read());
      const fullName = data?.full_name;
      if (typeof fullName !== "string" || !fullName.includes("/")) throw new GiteaError("unusable", "Gitea's repository answer has no full name");
      return { fullName, archived: data?.archived === true, internalTracker: data?.internal_tracker != null };
    });
  }

  async createIssue(owner: string, name: string, issue: { title: string; body: string }, signal?: AbortSignal): Promise<GiteaIssue> {
    return this.#call("POST", `${repoPath(owner, name)}/issues`, { title: issue.title, body: issue.body }, signal, async (response, read) => {
      if (response.status !== 201) throw await this.#reject(response, read);
      const data = parse(await read());
      const number = data?.number;
      const url = data?.html_url;
      if (typeof number !== "number" || typeof url !== "string") throw new GiteaError("unusable", "Gitea's issue answer has no number or address");
      return { number, url };
    });
  }

  async listIssues(owner: string, name: string, query: { state: GiteaIssueState | "all"; limit: number }, signal?: AbortSignal): Promise<GiteaIssueSummary[]> {
    const search = new URLSearchParams({ state: query.state, type: "issues", page: "1", limit: String(query.limit) });
    return this.#call("GET", `${repoPath(owner, name)}/issues?${search}`, undefined, signal, async (response, read) => {
      if (response.status !== 200) throw await this.#reject(response, read);
      const data = parseArray(await read());
      if (data === undefined) throw new GiteaError("unusable", "Gitea's issue list cannot be read");
      return data.map((item) => issueSummary(recordOf(item)));
    });
  }

  async getIssue(owner: string, name: string, index: number, signal?: AbortSignal): Promise<GiteaIssueDetail | "missing"> {
    return this.#call("GET", issuePath(owner, name, index), undefined, signal, async (response, read) => {
      if (response.status === 404) return "missing";
      if (response.status !== 200) throw await this.#reject(response, read);
      const data = parse(await read());
      const summary = issueSummary(data);
      const labels = Array.isArray(data?.labels)
        ? data.labels.flatMap((label) => {
            const name = recordOf(label)?.name;
            return typeof name === "string" ? [name] : [];
          })
        : [];
      return {
        ...summary,
        body: typeof data?.body === "string" ? data.body : "",
        labels,
        createdAt: typeof data?.created_at === "string" ? data.created_at : "",
      };
    });
  }

  async createComment(owner: string, name: string, index: number, comment: { body: string }, signal?: AbortSignal): Promise<GiteaComment> {
    return this.#call("POST", `${issuePath(owner, name, index)}/comments`, { body: comment.body }, signal, async (response, read) => {
      if (response.status !== 201) throw await this.#reject(response, read);
      const data = parse(await read());
      const id = data?.id;
      const url = data?.html_url;
      if (typeof id !== "number" || typeof url !== "string") throw new GiteaError("unusable", "Gitea's comment answer has no id or address");
      return { id, url };
    });
  }

  async editIssue(owner: string, name: string, index: number, patch: GiteaIssuePatch, signal?: AbortSignal): Promise<GiteaIssueSummary> {
    return this.#call("PATCH", issuePath(owner, name, index), patch, signal, async (response, read) => {
      if (response.status !== 200) throw await this.#reject(response, read);
      return issueSummary(parse(await read()));
    });
  }

  async #call<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    handle: (response: Response, read: () => Promise<string>) => Promise<T>,
  ): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const combined = signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal;
    const stopped = () =>
      deadline.signal.aborted
        ? new GiteaError("timeout", `Gitea did not answer within ${this.#timeoutMs} ms`)
        : new GiteaError("network", "the call to Gitea was cancelled");
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/api/v1${path}`, {
          method,
          headers: {
            authorization: `token ${this.#token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
          signal: combined,
        });
      } catch {
        if (combined.aborted) throw stopped();
        throw new GiteaError("network", "could not reach Gitea");
      }
      try {
        return await handle(response, () => readText(response, combined, stopped));
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** The error for an unexpected status, with Gitea's `message` as `detail`, the token taken out should it appear. */
  async #reject(response: Response, read: () => Promise<string>): Promise<GiteaError> {
    let detail: string | undefined;
    try {
      const message = parse(await read())?.message;
      if (typeof message === "string" && message !== "") detail = message.replaceAll(this.#token, "[token]").slice(0, MAX_DETAIL_CHARS);
    } catch {
      // No readable message: the status says enough.
    }
    return new GiteaError("status", `Gitea answered HTTP ${response.status}`, response.status, detail);
  }
}

/** The path of a repository; each segment encoded, so neither can reach another path. */
const repoPath = (owner: string, name: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

/** The path of one issue of a repository; the number is a whole number the tool checked, encoded like the rest. */
const issuePath = (owner: string, name: string, index: number) => `${repoPath(owner, name)}/issues/${encodeURIComponent(String(index))}`;

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const data: unknown = JSON.parse(text);
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseArray(text: string): unknown[] | undefined {
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** An issue as the list shows it, from Gitea's answer; the number, title, state and address must be there, the rest defaults. */
function issueSummary(data: Record<string, unknown> | undefined): GiteaIssueSummary {
  const number = data?.number;
  const title = data?.title;
  const url = data?.html_url;
  const state = data?.state;
  if (typeof number !== "number" || typeof title !== "string" || typeof url !== "string" || (state !== "open" && state !== "closed"))
    throw new GiteaError("unusable", "Gitea's issue answer cannot be read");
  const author = recordOf(data?.user)?.login;
  return {
    number,
    title,
    state,
    url,
    author: typeof author === "string" ? author : "",
    comments: typeof data?.comments === "number" ? data.comments : 0,
    updatedAt: typeof data?.updated_at === "string" ? data.updated_at : "",
  };
}

async function readText(response: Response, signal: AbortSignal, stopped: () => GiteaError): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new GiteaError("unusable", "Gitea's answer is larger than expected");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof GiteaError) throw error;
    throw signal.aborted ? stopped() : new GiteaError("network", "the connection to Gitea broke while reading the answer");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
