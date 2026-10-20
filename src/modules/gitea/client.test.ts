import { afterEach, expect, test } from "bun:test";
import { FAKE_GITEA_TOKEN, type FakeGitea, startFakeGitea } from "../../testing/fake-gitea.ts";
import { GiteaError, GiteaHttpClient } from "./client.ts";

let gitea: FakeGitea | undefined;
afterEach(async () => {
  await gitea?.stop();
  gitea = undefined;
});

function setup(options: { token?: string; timeoutMs?: number } = {}) {
  gitea = startFakeGitea();
  gitea.repos.set("team/app", { full_name: "Team/App" });
  return { gitea, client: new GiteaHttpClient({ baseUrl: `${gitea.url}/`, token: options.token ?? FAKE_GITEA_TOKEN, timeoutMs: options.timeoutMs ?? 2000 }) };
}

async function failure(work: Promise<unknown>): Promise<GiteaError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof GiteaError) return error;
    throw error;
  }
  throw new Error("expected a GiteaError");
}

test("a repository is read with the token in the header, in Gitea's case, and what its issues are", async () => {
  const { gitea, client } = setup();
  expect(await client.repo("team", "app")).toEqual({ fullName: "Team/App", archived: false, internalTracker: true });
  expect(gitea.seen[0]).toMatchObject({ method: "GET", path: "/api/v1/repos/team/app", authorization: `token ${FAKE_GITEA_TOKEN}` });
  gitea.repos.set("team/old", { full_name: "team/old", archived: true });
  gitea.repos.set("team/ext", { full_name: "team/ext", issues: "external" });
  gitea.repos.set("team/off", { full_name: "team/off", issues: "off" });
  expect(await client.repo("team", "old")).toMatchObject({ archived: true, internalTracker: true });
  expect(await client.repo("team", "ext")).toMatchObject({ internalTracker: false });
  expect(await client.repo("team", "off")).toMatchObject({ internalTracker: false });
});

test("a repository not there is missing, a renamed one moved, and the redirect is not followed", async () => {
  const { gitea, client } = setup();
  expect(await client.repo("team", "nope")).toBe("missing");
  gitea.moved.set("team/before", "team/app");
  expect(await client.repo("team", "before")).toBe("moved");
  expect(gitea.seen.map((seen) => seen.path)).toEqual(["/api/v1/repos/team/nope", "/api/v1/repos/team/before"]);
});

test("each segment of the path is encoded, so neither reaches another path", async () => {
  const { gitea, client } = setup();
  expect(await client.repo("a/../b", "c?d#e")).toBe("missing");
  expect(gitea.seen[0]?.path).toBe("/api/v1/repos/a%2F..%2Fb/c%3Fd%23e");
});

test("a refused token, a missing scope and a broken Gitea throw a status error that carries Gitea's message for the log, never the token", async () => {
  const bad = setup({ token: "wrong-token" });
  expect(await failure(bad.client.repo("team", "app"))).toMatchObject({ kind: "status", status: 401 });
  await bad.gitea.stop();

  const { gitea, client } = setup();
  gitea.repoAnswer = { status: 403, message: `token does not have at least one of required scope(s): ${FAKE_GITEA_TOKEN}` };
  const scope = await failure(client.repo("team", "app"));
  expect(scope).toMatchObject({ kind: "status", status: 403 });
  expect(scope.detail).toContain("required scope");
  expect(`${scope.message} ${scope.detail}`).not.toContain(FAKE_GITEA_TOKEN);
  gitea.repoAnswer = { status: 500 };
  expect(await failure(client.repo("team", "app"))).toMatchObject({ kind: "status", status: 500 });
});

test("an issue is posted with its title and body and comes back with its number and address", async () => {
  const { gitea, client } = setup();
  const issue = await client.createIssue("team", "app", { title: "Login fails", body: "steps" });
  expect(issue).toEqual({ number: 1, url: `${gitea.url}/Team/App/issues/1` });
  expect(gitea.seen[0]).toEqual({
    method: "POST",
    path: "/api/v1/repos/team/app/issues",
    authorization: `token ${FAKE_GITEA_TOKEN}`,
    body: { title: "Login fails", body: "steps" },
  });
});

test("filing fails by status, by timeout, by a broken connection, and on an answer that cannot be read", async () => {
  const { gitea, client } = setup({ timeoutMs: 100 });
  for (const status of [403, 404, 422, 423, 500]) {
    gitea.issueAnswers.push({ status });
    expect(await failure(client.createIssue("team", "app", { title: "t", body: "" }))).toMatchObject({ kind: "status", status });
  }
  gitea.moved.set("team/before", "team/app");
  expect(await failure(client.createIssue("team", "before", { title: "t", body: "" }))).toMatchObject({ kind: "status", status: 301 });
  gitea.issueAnswers.push("garbage");
  expect((await failure(client.createIssue("team", "app", { title: "t", body: "" }))).kind).toBe("unusable");
  gitea.issueAnswers.push("hang");
  expect((await failure(client.createIssue("team", "app", { title: "t", body: "" }))).kind).toBe("timeout");
  gitea.issueAnswers.push("close");
  expect((await failure(client.createIssue("team", "app", { title: "t", body: "" }))).kind).toBe("network");
});

test("a Gitea not reached is a network error; the caller's signal stops a call too", async () => {
  const client = new GiteaHttpClient({ baseUrl: "http://127.0.0.1:9", token: FAKE_GITEA_TOKEN });
  const unreachable = await failure(client.repo("team", "app"));
  expect(unreachable.kind).toBe("network");
  expect(unreachable.message).not.toContain(FAKE_GITEA_TOKEN);

  const { gitea, client: slow } = setup({ timeoutMs: 5000 });
  gitea.repoAnswer = "hang";
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 50);
  expect((await failure(slow.repo("team", "app", stop.signal))).kind).toBe("network");
});
