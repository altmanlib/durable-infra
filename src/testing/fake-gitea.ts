/** A Gitea that answers the issue tools' calls over real HTTP, for tests; its token is a secret the tests look for in logs. */

export const FAKE_GITEA_TOKEN = "fake-gitea-token-7f3a91c2";

/** An issue a repository starts with, before any test files one. */
export type FakeSeedIssue = {
  title: string;
  body?: string;
  state?: "open" | "closed";
  author?: string;
  labels?: string[];
  /** The bodies of the comments it starts with, oldest first. */
  comments?: string[];
};

/** What the fake knows of a repository; keyed by `owner/name` in lower case, as Gitea looks names up. */
export type FakeRepo = { full_name: string; archived?: boolean; issues?: "internal" | "external" | "off"; seedIssues?: FakeSeedIssue[] };

/** How the fake answers a call: as Gitea would, with a status and a message, without answering, or with garbage. */
export type IssueAnswer = { status: number; message?: string } | "hang" | "garbage" | "close";

export type Seen = { method: string; path: string; authorization: string | null; body: unknown };

type FakeComment = { id: number; body: string; author: string };

type FakeIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: string;
  labels: string[];
  comments: FakeComment[];
  created_at: string;
  updated_at: string;
};

export type FakeGitea = {
  /** The root address to configure, without `/api/v1`. */
  url: string;
  repos: Map<string, FakeRepo>;
  /** Renamed repositories: old `owner/name` (lower case) to the new one, answered with a 301 as Gitea does. */
  moved: Map<string, string>;
  /** Overrides the next answers to POST issues, first first; empty means file it. */
  issueAnswers: IssueAnswer[];
  /** Overrides the next answers to reading issues (the list or one issue), first first; empty means answer them. */
  readAnswers: IssueAnswer[];
  /** Overrides the next answers to POST a comment, first first; empty means post it. */
  commentAnswers: IssueAnswer[];
  /** Overrides the next answers to PATCH an issue, first first; empty means apply it. */
  editAnswers: IssueAnswer[];
  /** An answer to GET a repository instead of the usual one. */
  repoAnswer?: { status: number; message?: string } | "hang";
  seen: Seen[];
  stop(): Promise<void>;
};

export function startFakeGitea(): FakeGitea {
  let next = 1;
  let nextComment = 1;
  const store = new Map<string, FakeIssue[]>();
  const fake: Omit<FakeGitea, "url" | "stop"> = {
    repos: new Map(),
    moved: new Map(),
    issueAnswers: [],
    readAnswers: [],
    commentAnswers: [],
    editAnswers: [],
    seen: [],
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const failure = (status: number, message = "failed") => json(status, { message, url: "https://gitea.example/api/swagger" });
  const never = (request: Request) =>
    new Promise<Response>((resolve) => request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 }))));

  /** The issues of a repository, its seeds first; created on first use, so a test may seed a repository any time before. */
  const issuesOf = (name: string, repo: FakeRepo): FakeIssue[] => {
    let issues = store.get(name);
    if (issues === undefined) {
      issues = (repo.seedIssues ?? []).map((seed) => ({
        number: next++,
        title: seed.title,
        body: seed.body ?? "",
        state: seed.state ?? "open",
        author: seed.author ?? "someone",
        labels: seed.labels ?? [],
        comments: (seed.comments ?? []).map((body) => ({ id: nextComment++, body, author: seed.author ?? "someone" })),
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }));
      store.set(name, issues);
    }
    return issues;
  };

  const server: Bun.Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      const text = request.method === "POST" || request.method === "PATCH" ? await request.text() : "";
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      fake.seen.push({ method: request.method, path: url.pathname + url.search, authorization: request.headers.get("authorization"), body });
      if (request.headers.get("authorization") !== `token ${FAKE_GITEA_TOKEN}`) return failure(401, "user does not exist [uid: 0, name: ]");
      const match = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)(?:\/issues(?:\/(\d+)(\/comments)?)?)?$/.exec(url.pathname);
      if (!match) return failure(404, "not found");
      const name = `${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`.toLowerCase();
      const renamed = fake.moved.get(name);
      if (renamed)
        return new Response(null, {
          status: 301,
          headers: { location: `/api/v1/repos/${renamed}${url.pathname.slice(`/api/v1/repos/${match[1]}/${match[2]}`.length)}` },
        });
      const repo = fake.repos.get(name);
      const issueJson = (issue: FakeIssue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        html_url: `${fakeUrl}/${repo?.full_name}/issues/${issue.number}`,
        user: { login: issue.author },
        labels: issue.labels.map((label) => ({ name: label })),
        comments: issue.comments.length,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
      });
      /** What an override answers instead of the call, or undefined to let the call through; `okStatus` is the status garbage wears. */
      const overridden = async (answer: IssueAnswer | undefined, okStatus: number): Promise<Response | undefined> => {
        if (answer === undefined) return undefined;
        if (answer === "hang") return never(request);
        if (answer === "garbage") return new Response("<html>proxy</html>", { status: okStatus });
        if (answer === "close") {
          server.stop(true);
          return never(request);
        }
        return failure(answer.status, answer.message);
      };
      if (match[3] === undefined && match[4] === undefined && !url.pathname.endsWith("/issues") && request.method === "GET") {
        if (fake.repoAnswer === "hang") return never(request);
        if (fake.repoAnswer) return failure(fake.repoAnswer.status, fake.repoAnswer.message);
        if (!repo) return failure(404, "repository does not exist");
        const issues = repo.issues ?? "internal";
        return json(200, {
          full_name: repo.full_name,
          archived: repo.archived ?? false,
          has_issues: issues !== "off",
          ...(issues === "internal" ? { internal_tracker: { enable_time_tracker: true } } : {}),
          ...(issues === "external" ? { external_tracker: { external_tracker_url: "https://tracker.example" } } : {}),
          permissions: { admin: false, push: false, pull: true },
        });
      }
      const onIssues = url.pathname.endsWith("/issues") || match[3] !== undefined;
      if (!onIssues) return failure(405, "method not allowed");
      if (match[3] === undefined) {
        if (request.method === "POST") {
          const answered = await overridden(fake.issueAnswers.shift(), 201);
          if (answered) return answered;
          if (!repo) return failure(404, "repository does not exist");
          const input = body as { title?: string; body?: string };
          const issues = issuesOf(name, repo);
          const issue: FakeIssue = {
            number: next++,
            title: input?.title ?? "",
            body: input?.body ?? "",
            state: "open",
            author: "bot",
            labels: [],
            comments: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          issues.push(issue);
          return json(201, { number: issue.number, html_url: `${fakeUrl}/${repo.full_name}/issues/${issue.number}`, title: issue.title });
        }
        if (request.method === "GET") {
          const answered = await overridden(fake.readAnswers.shift(), 200);
          if (answered) return answered;
          if (!repo) return failure(404, "repository does not exist");
          const state = url.searchParams.get("state") ?? "open";
          const limit = Number(url.searchParams.get("limit") ?? "30");
          const issues = issuesOf(name, repo)
            .filter((issue) => state === "all" || issue.state === state)
            .slice()
            .reverse()
            .slice(0, limit);
          return json(200, issues.map(issueJson));
        }
        return failure(405, "method not allowed");
      }
      const index = Number(match[3]);
      const issue = repo ? issuesOf(name, repo).find((candidate) => candidate.number === index) : undefined;
      if (match[4] === "/comments" && request.method === "POST") {
        const answered = await overridden(fake.commentAnswers.shift(), 201);
        if (answered) return answered;
        if (!repo) return failure(404, "repository does not exist");
        if (!issue) return failure(404, "issue does not exist");
        const comment: FakeComment = { id: nextComment++, body: (body as { body?: string })?.body ?? "", author: "bot" };
        issue.comments.push(comment);
        issue.updated_at = new Date().toISOString();
        return json(201, { id: comment.id, html_url: `${fakeUrl}/${repo.full_name}/issues/${issue.number}#issuecomment-${comment.id}`, body: comment.body });
      }
      if (match[4] === undefined && request.method === "GET") {
        const answered = await overridden(fake.readAnswers.shift(), 200);
        if (answered) return answered;
        if (!repo) return failure(404, "repository does not exist");
        if (!issue) return failure(404, "issue does not exist");
        return json(200, issueJson(issue));
      }
      if (match[4] === undefined && request.method === "PATCH") {
        const answered = await overridden(fake.editAnswers.shift(), 200);
        if (answered) return answered;
        if (!repo) return failure(404, "repository does not exist");
        if (!issue) return failure(404, "issue does not exist");
        const patch = body as { title?: string; body?: string; state?: "open" | "closed" };
        if (patch?.title !== undefined) issue.title = patch.title;
        if (patch?.body !== undefined) issue.body = patch.body;
        if (patch?.state !== undefined) issue.state = patch.state;
        issue.updated_at = new Date().toISOString();
        return json(200, issueJson(issue));
      }
      return failure(405, "method not allowed");
    },
  });
  const fakeUrl: string = `http://127.0.0.1:${server.port}`;
  return Object.assign(fake, { url: fakeUrl, stop: () => server.stop(true) }) as FakeGitea;
}
