import { afterEach, expect, test } from "bun:test";

import { FAKE_GITEA_TOKEN, type FakeGitea, startFakeGitea } from "../../testing/fake-gitea.ts";
import { captureLogs } from "../../testing/testing.ts";
import { GiteaHttpClient } from "./client.ts";
import { giteaRepoSetting, repoOf } from "./settings.ts";

let gitea: FakeGitea | undefined;
afterEach(async () => {
  await gitea?.stop();
  gitea = undefined;
});

const signal = new AbortController().signal;
const context = { conversationKey: "feishu:oc_1", signal };

function setup(token = FAKE_GITEA_TOKEN) {
  gitea = startFakeGitea();
  gitea.repos.set("team/app", { full_name: "Team/App" });
  return { gitea, spec: giteaRepoSetting(new GiteaHttpClient({ baseUrl: gitea.url, token, timeoutMs: 2000 }), gitea.url) };
}

test("owner/repo and an address of the configured Gitea are read; another host, a dot segment or a missing part are not", () => {
  const base = "https://git.test/sub";
  expect(repoOf("team/app", base)).toEqual({ owner: "team", repo: "app" });
  expect(repoOf(" team/app.git ", base)).toEqual({ owner: "team", repo: "app" });
  for (const address of ["https://git.test/sub/team/app", "http://GIT.test/sub/team/app/", "https://git.test/sub/team/app.git"])
    expect(repoOf(address, base)).toEqual({ owner: "team", repo: "app" });
  for (const bad of [
    "https://evil.test/sub/team/app",
    "https://git.test/team/app",
    "https://git.test/sub/team/app/issues/3",
    "team",
    "team/",
    "../app",
    "team/..",
    "a/b/c",
    "te am/app",
    "",
  ])
    expect(repoOf(bad, base)).toBeUndefined();
});

test("a repository that is there, with Gitea's own issues, is kept as Gitea names it", async () => {
  const { spec } = setup();
  expect(await spec.check("team/app", context)).toEqual({ ok: true, value: "Team/App" });
  expect(await spec.check(`${gitea?.url}/TEAM/app.git`, context)).toEqual({ ok: true, value: "Team/App" });
  expect(spec.decode("Team/App")).toEqual({ owner: "Team", repo: "App" });
  for (const bad of ["Team", "a/b/c", "../x", "a/.."]) expect(spec.decode(bad)).toBeUndefined();
});

test("bad input is invalid_value; missing, renamed, archived and no own issues are rejected, with fixed reasons", async () => {
  const { gitea, spec } = setup();
  gitea.repos.set("team/old", { full_name: "team/old", archived: true });
  gitea.repos.set("team/ext", { full_name: "team/ext", issues: "external" });
  gitea.repos.set("team/off", { full_name: "team/off", issues: "off" });
  gitea.moved.set("team/before", "team/app");
  expect(await spec.check("https://elsewhere.test/team/app", context)).toMatchObject({ ok: false, code: "invalid_value" });
  for (const input of ["team/nope", "team/before", "team/old", "team/ext", "team/off"])
    expect(await spec.check(input, context)).toMatchObject({ ok: false, code: "rejected" });
  // Nothing Gitea said reaches the reason.
  const missing = await spec.check("team/nope", context);
  expect(JSON.stringify(missing)).not.toContain("repository does not exist");
});

test("a check that cannot tell throws, so nothing is kept; a refused token is logged for the operator, never shown", async () => {
  const { gitea, spec } = setup("wrong-token");
  const lines = await captureLogs(async () => {
    await expect(Promise.resolve(spec.check("team/app", context))).rejects.toThrow("401");
  });
  expect(lines.some(({ line, level }) => level === "error" && line.includes("gitea.auth_failed") && line.includes("status=401"))).toBe(true);
  expect(lines.map(({ line }) => line).join("\n")).not.toContain(FAKE_GITEA_TOKEN);
  await gitea.stop();
  await expect(Promise.resolve(spec.check("team/app", context))).rejects.toThrow();
});
