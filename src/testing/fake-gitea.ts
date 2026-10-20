/**
 * A Gitea that answers over real HTTP the two calls the issue tool makes (docs/design/2026-10-20-gitea-issue.md §2), for
 * the tests of the client, the setting and the tool. Its token is a secret the tests look for in logs and errors.
 */

export const FAKE_GITEA_TOKEN = "fake-gitea-token-7f3a91c2";

/** What the fake knows of a repository; keyed by `owner/name` in lower case, as Gitea looks names up. */
export type FakeRepo = { full_name: string; archived?: boolean; issues?: "internal" | "external" | "off" };

/** How the fake answers a new issue: as Gitea would, with a status and a message, without answering, or with garbage. */
export type IssueAnswer = { status: number; message?: string } | "hang" | "garbage" | "close";

export type Seen = { method: string; path: string; authorization: string | null; body: unknown };

export type FakeGitea = {
  /** The root address to configure, without `/api/v1`. */
  url: string;
  repos: Map<string, FakeRepo>;
  /** Renamed repositories: old `owner/name` (lower case) to the new one, answered with a 301 as Gitea does. */
  moved: Map<string, string>;
  /** Overrides the next answers to POST issues, first first; empty means file it. */
  issueAnswers: IssueAnswer[];
  /** An answer to GET a repository instead of the usual one. */
  repoAnswer?: { status: number; message?: string } | "hang";
  seen: Seen[];
  stop(): Promise<void>;
};

export function startFakeGitea(): FakeGitea {
  let next = 1;
  const fake: Omit<FakeGitea, "url" | "stop"> = { repos: new Map(), moved: new Map(), issueAnswers: [], seen: [] };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const failure = (status: number, message = "failed") => json(status, { message, url: "https://gitea.example/api/swagger" });
  const never = (request: Request) =>
    new Promise<Response>((resolve) => request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 }))));

  const server: Bun.Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      const text = request.method === "POST" ? await request.text() : "";
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      fake.seen.push({ method: request.method, path: url.pathname, authorization: request.headers.get("authorization"), body });
      if (request.headers.get("authorization") !== `token ${FAKE_GITEA_TOKEN}`) return failure(401, "user does not exist [uid: 0, name: ]");
      const match = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)(\/issues)?$/.exec(url.pathname);
      if (!match) return failure(404, "not found");
      const name = `${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`.toLowerCase();
      const renamed = fake.moved.get(name);
      if (renamed) return new Response(null, { status: 301, headers: { location: `/api/v1/repos/${renamed}${match[3] ?? ""}` } });
      const repo = fake.repos.get(name);
      if (match[3] === undefined && request.method === "GET") {
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
      if (match[3] === "/issues" && request.method === "POST") {
        const answer = fake.issueAnswers.shift();
        if (answer === "hang") return never(request);
        if (answer === "garbage") return new Response("<html>proxy</html>", { status: 201 });
        if (answer === "close") {
          server.stop(true);
          return never(request);
        }
        if (answer) return failure(answer.status, answer.message);
        if (!repo) return failure(404, "repository does not exist");
        const number = next++;
        return json(201, { number, html_url: `${fakeUrl}/${repo.full_name}/issues/${number}`, title: (body as { title?: string })?.title });
      }
      return failure(405, "method not allowed");
    },
  });
  const fakeUrl: string = `http://127.0.0.1:${server.port}`;
  return Object.assign(fake, { url: fakeUrl, stop: () => server.stop(true) }) as FakeGitea;
}
