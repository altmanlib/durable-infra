import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { ConversationSettings, SettingCatalog, type SettingSpec, type SettingStore } from "../../kernel/conversation-settings/index.ts";
import { openSettingStore } from "../../kernel/conversation-settings/records/index.ts";
import { ConversationKeys } from "../../kernel/service/notices.ts";
import { Outbox } from "../../kernel/service/outbox.ts";
import { Records } from "../../platform/records/records.ts";
import { FAKE_GITEA_TOKEN, type FakeGitea, startFakeGitea } from "../../testing/fake-gitea.ts";
import { captureLogs, defaultPrompts, toolDeps } from "../../testing/testing.ts";
import { builtinTools, PRIVILEGED_TOOLS, SHARED_TOOLS } from "../../testing/tools.ts";
import { createGiteaIssueTool, GITEA_ISSUE_CREATE, type GiteaTools, MAX_ISSUE_BODY_CHARS, MAX_ISSUE_TITLE_CHARS } from "./gitea.ts";
import { GiteaHttpClient, giteaRepoSetting } from "./index.ts";

let records: Records | undefined;
let gitea: FakeGitea | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
  await gitea?.stop();
  gitea = undefined;
});

async function setup(options: { token?: string; timeoutMs?: number; repo?: string } = {}) {
  gitea = startFakeGitea();
  gitea.repos.set("team/app", { full_name: "Team/App" });
  const client = new GiteaHttpClient({ baseUrl: gitea.url, token: options.token ?? FAKE_GITEA_TOKEN, timeoutMs: options.timeoutMs ?? 2000 });
  const tools: GiteaTools = { client, repo: giteaRepoSetting(client, gitea.url) };
  records = await Records.open(":memory:");
  const store: SettingStore = await openSettingStore(records);
  if (options.repo !== undefined) await store.write("feishu:oc_1", "gitea.repo", options.repo, "ou_boss");
  const settings = new ConversationSettings(new SettingCatalog([tools.repo as SettingSpec<unknown>]), store);
  return { gitea, tools, settings, tool: createGiteaIssueTool({ settings, prompts: defaultPrompts, gitea: tools }) };
}

/** What the tool reads of the session: the channel key, and the run's input matched to the outbox item of `speaker`. */
function api(key: string | undefined, speaker?: { id: string; name?: string }) {
  return {
    conversationId: 7,
    snapshot: async (definition: unknown) => {
      if (definition === ConversationKeys) return key === undefined ? undefined : { key };
      if (definition === LiveDoc) return { run: { inputs: [11] } };
      if (definition === Outbox) return { items: speaker ? [{ key, requestId: "r", text: "t", speaker, submission: 11, shared: true }] : [] };
      return undefined;
    },
  } as never;
}

type Result = { output?: { type: string; text?: string }[]; details?: unknown; isError?: boolean };
const codeOf = (result: Result) => (result.details as { code?: string } | undefined)?.code;
const textOf = (result: Result) => (result.output ?? []).map((part) => part.text ?? "").join("");

const run = (tool: { execute: (...args: never[]) => unknown }, args: Record<string, unknown>, on = api("feishu:oc_1", { id: "ou_guest", name: "小王" })) =>
  (tool.execute as (args: unknown, api: unknown, context: unknown) => Promise<Result>)(args, on, BACKGROUND_CONTEXT);

test("installed only with Gitea, deferred and not replayed; everyone in a group may use it", async () => {
  expect(builtinTools(toolDeps()).map((tool) => tool.name)).not.toContain(GITEA_ISSUE_CREATE);
  const { tools, settings } = await setup();
  const installed = builtinTools(toolDeps({ settings, gitea: tools }));
  const tool = installed.find((candidate) => candidate.name === GITEA_ISSUE_CREATE);
  expect([tool?.deferred, tool?.replay]).toEqual([true, "unsafe"]);
  // Last, after the settings tools.
  expect(installed.at(-1)?.name).toBe(GITEA_ISSUE_CREATE);
  expect(SHARED_TOOLS).toContain(GITEA_ISSUE_CREATE);
  expect(PRIVILEGED_TOOLS).not.toContain(GITEA_ISSUE_CREATE);
});

test("an issue is filed in the group's repository, one line of title, signed with who asked, and its address comes back", async () => {
  const { gitea, tool } = await setup({ repo: "Team/App" });
  let result: Result | undefined;
  const lines = await captureLogs(async () => {
    result = await run(tool, { title: "  登录页\n报错 ", body: "背景\n\n期望\n" });
  });
  if (!result) throw new Error("no result");
  expect(codeOf(result)).toBe("created");
  expect(textOf(result)).toContain(`${gitea.url}/Team/App/issues/1`);
  const sent = gitea.seen.at(-1);
  expect(sent?.path).toBe("/api/v1/repos/Team/App/issues");
  const body = sent?.body as { title: string; body: string };
  expect(body.title).toBe("登录页 报错");
  expect(body.body.startsWith("背景\n\n期望")).toBe(true);
  // Signed after what the model wrote, with the asker's name.
  expect(body.body.lastIndexOf("小王")).toBeGreaterThan(body.body.indexOf("期望"));
  const created = lines.find(({ line }) => line.includes("gitea.issue_created"))?.line ?? "";
  for (const fact of ["key=feishu:oc_1", "repo=Team/App", "number=1", "by=ou_guest"]) expect(created).toContain(fact);
  expect(lines.map(({ line }) => line).join("\n")).not.toContain(FAKE_GITEA_TOKEN);
});

test("without a name the signature has the id, and without a known asker it names nobody", async () => {
  const { gitea, tool } = await setup({ repo: "Team/App" });
  await run(tool, { title: "a", body: "" }, api("feishu:oc_1", { id: "ou_noname" }));
  expect((gitea.seen.at(-1)?.body as { body?: string } | undefined)?.body).toContain("ou_noname");
  await run(tool, { title: "b", body: "x" }, api("feishu:oc_1"));
  const unsigned = (gitea.seen.at(-1)?.body as { body?: string } | undefined)?.body ?? "";
  expect(unsigned.startsWith("x")).toBe(true);
  expect(unsigned.length).toBeGreaterThan(1);
  for (const stray of ["undefined", "ou_"]) expect(unsigned).not.toContain(stray);
});

test("no key, no repository, an empty or too long title, a too long body: nothing is sent", async () => {
  const unset = await setup();
  expect(codeOf(await run(unset.tool, { title: "t", body: "" }, api(undefined)))).toBe("no_conversation");
  expect(codeOf(await run(unset.tool, { title: "t", body: "" }))).toBe("no_repo");
  await records?.close();
  records = undefined;
  await gitea?.stop();

  const { gitea: set, tool } = await setup({ repo: "Team/App" });
  for (const args of [
    { title: " \n ", body: "" },
    { title: "x".repeat(MAX_ISSUE_TITLE_CHARS + 1), body: "" },
    { title: "t", body: "x".repeat(MAX_ISSUE_BODY_CHARS + 1) },
  ])
    expect(codeOf(await run(tool, args))).toBe("invalid_input");
  expect(set.seen).toEqual([]);
});

test("what Gitea answers decides the code: unavailable, invalid, failed for sure, or not known", async () => {
  const { gitea, tool } = await setup({ repo: "Team/App", timeoutMs: 100 });
  const cases: [Parameters<FakeGitea["issueAnswers"]["push"]>[0], string][] = [
    [{ status: 403 }, "repo_unavailable"],
    [{ status: 404 }, "repo_unavailable"],
    [{ status: 423 }, "repo_unavailable"],
    [{ status: 422 }, "invalid_input"],
    [{ status: 400 }, "failed"],
    [{ status: 500, message: `broke ${FAKE_GITEA_TOKEN}` }, "uncertain"],
    ["hang", "uncertain"],
    ["garbage", "uncertain"],
  ];
  const lines = await captureLogs(async () => {
    for (const [answer, code] of cases) {
      gitea.issueAnswers.push(answer);
      const result = await run(tool, { title: "t", body: "" });
      expect([codeOf(result), result.isError]).toEqual([code, true]);
    }
  });
  const failed = lines.filter(({ line }) => line.includes("gitea.issue_failed"));
  expect(failed.length).toBe(cases.length);
  expect(failed.some(({ line }) => line.includes("kind=timeout"))).toBe(true);
  expect(lines.map(({ line }) => line).join("\n")).not.toContain(FAKE_GITEA_TOKEN);
});

test("a renamed repository is unavailable; a refused token fails for sure and is an error for the operator", async () => {
  const { gitea, tool } = await setup({ repo: "team/before" });
  gitea.moved.set("team/before", "team/app");
  expect(codeOf(await run(tool, { title: "t", body: "" }))).toBe("repo_unavailable");
  await records?.close();
  records = undefined;
  await gitea.stop();

  const refused = await setup({ repo: "Team/App", token: "wrong-token" });
  let result: Result | undefined;
  const lines = await captureLogs(async () => {
    result = await run(refused.tool, { title: "t", body: "" });
  });
  expect(result && codeOf(result)).toBe("failed");
  expect(lines.some(({ line, level }) => level === "error" && line.includes("gitea.issue_failed") && line.includes("status=401"))).toBe(true);
});
