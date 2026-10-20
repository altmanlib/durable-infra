import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { ConversationSettings, SettingCatalog, type SettingSpec, type SettingStore } from "../../kernel/conversation-settings/index.ts";
import { openSettingStore } from "../../kernel/conversation-settings/records/index.ts";
import { ConversationKeys } from "../../kernel/service/notices.ts";
import { Outbox } from "../../kernel/service/outbox.ts";
import { Records } from "../../platform/records/records.ts";
import { FAKE_GITEA_TOKEN, type FakeGitea, type FakeSeedIssue, startFakeGitea } from "../../testing/fake-gitea.ts";
import { captureLogs, defaultPrompts, toolDeps } from "../../testing/testing.ts";
import { builtinTools, PRIVILEGED_TOOLS, SHARED_TOOLS } from "../../testing/tools.ts";
import {
  createGiteaIssueCommentTool,
  createGiteaIssueEditTool,
  createGiteaIssueGetTool,
  createGiteaIssueListTool,
  createGiteaIssueTool,
  GITEA_ISSUE_COMMENT_CREATE,
  GITEA_ISSUE_CREATE,
  GITEA_ISSUE_EDIT,
  GITEA_ISSUE_GET,
  GITEA_ISSUE_LIST,
  type GiteaTools,
  MAX_ISSUE_BODY_CHARS,
  MAX_ISSUE_TITLE_CHARS,
} from "./gitea.ts";
import { GiteaHttpClient, giteaRepoSetting } from "./index.ts";

let records: Records | undefined;
let gitea: FakeGitea | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
  await gitea?.stop();
  gitea = undefined;
});

async function setup(options: { token?: string; timeoutMs?: number; repo?: string; seeds?: FakeSeedIssue[] } = {}) {
  gitea = startFakeGitea();
  gitea.repos.set("team/app", { full_name: "Team/App", seedIssues: options.seeds });
  const client = new GiteaHttpClient({ baseUrl: gitea.url, token: options.token ?? FAKE_GITEA_TOKEN, timeoutMs: options.timeoutMs ?? 2000 });
  const tools: GiteaTools = { client, repo: giteaRepoSetting(client, gitea.url) };
  records = await Records.open(":memory:");
  const store: SettingStore = await openSettingStore(records);
  if (options.repo !== undefined) await store.write("feishu:oc_1", "gitea.repo", options.repo, "ou_boss");
  const settings = new ConversationSettings(new SettingCatalog([tools.repo as SettingSpec<unknown>]), store);
  const deps = { settings, prompts: defaultPrompts, gitea: tools };
  return {
    gitea,
    tools,
    settings,
    tool: createGiteaIssueTool(deps),
    listTool: createGiteaIssueListTool(deps),
    getTool: createGiteaIssueGetTool(deps),
    commentTool: createGiteaIssueCommentTool(deps),
    editTool: createGiteaIssueEditTool(deps),
  };
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

test("installed only with Gitea, deferred; everyone in a group may use them, and only the writes that can duplicate are not replayed", async () => {
  const names = [GITEA_ISSUE_CREATE, GITEA_ISSUE_LIST, GITEA_ISSUE_GET, GITEA_ISSUE_COMMENT_CREATE, GITEA_ISSUE_EDIT];
  for (const name of names) expect(builtinTools(toolDeps()).map((tool) => tool.name)).not.toContain(name);
  const { tools, settings } = await setup();
  const installed = builtinTools(toolDeps({ settings, gitea: tools }));
  const byName = new Map(installed.map((tool) => [tool.name, tool]));
  // Filing and commenting are not replayed: twice would file or post twice. Reading and editing name an end state, so they are.
  expect([byName.get(GITEA_ISSUE_CREATE)?.deferred, byName.get(GITEA_ISSUE_CREATE)?.replay]).toEqual([true, "unsafe"]);
  expect([byName.get(GITEA_ISSUE_LIST)?.deferred, byName.get(GITEA_ISSUE_LIST)?.replay]).toEqual([true, "safe"]);
  expect([byName.get(GITEA_ISSUE_GET)?.deferred, byName.get(GITEA_ISSUE_GET)?.replay]).toEqual([true, "safe"]);
  expect([byName.get(GITEA_ISSUE_COMMENT_CREATE)?.deferred, byName.get(GITEA_ISSUE_COMMENT_CREATE)?.replay]).toEqual([true, "unsafe"]);
  expect([byName.get(GITEA_ISSUE_EDIT)?.deferred, byName.get(GITEA_ISSUE_EDIT)?.replay]).toEqual([true, "safe"]);
  // Last, after the settings tools, in the module's order.
  expect(installed.slice(-names.length).map((tool) => tool.name)).toEqual(names);
  for (const name of names) {
    expect(SHARED_TOOLS).toContain(name);
    expect(PRIVILEGED_TOOLS).not.toContain(name);
  }
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

const SEEDS: FakeSeedIssue[] = [
  { title: "登录页报错", body: "点登录就白屏", author: "alice", labels: ["bug"], comments: ["我也遇到了"] },
  { title: "导出按钮没反应", author: "bob" },
  { title: "老问题", state: "closed", author: "alice" },
];

test("the list shows the repository's issues newest first, by state, capped by the limit", async () => {
  const { gitea, listTool } = await setup({ repo: "Team/App", seeds: SEEDS });
  const open = await run(listTool, {});
  expect(codeOf(open)).toBe("listed");
  const text = textOf(open);
  expect(text).toContain("#2 导出按钮没反应");
  expect(text).toContain("#1 登录页报错");
  expect(text).not.toContain("老问题");
  expect(text.indexOf("#2")).toBeLessThan(text.indexOf("#1"));
  expect(gitea.seen.at(-1)?.path).toContain("/api/v1/repos/Team/App/issues?state=open&type=issues&page=1&limit=20");

  const closed = await run(listTool, { state: "closed" });
  expect(textOf(closed)).toContain("#3 老问题");
  expect(textOf(closed)).not.toContain("登录页报错");
  const one = await run(listTool, { state: "all", limit: 1 });
  expect(textOf(one)).toContain("#3 老问题");
  expect(textOf(one)).not.toContain("#2");
});

test("an empty list says so; without a repository nothing is read", async () => {
  const { listTool } = await setup({ repo: "Team/App" });
  const empty = await run(listTool, {});
  expect(codeOf(empty)).toBe("listed");
  expect(textOf(empty)).toContain("no open issues");
  await records?.close();
  records = undefined;
  await gitea?.stop();

  const unset = await setup();
  expect(codeOf(await run(unset.listTool, {}))).toBe("no_repo");
  expect(codeOf(await run(unset.getTool, { issue: 1 }))).toBe("no_repo");
  expect(codeOf(await run(unset.commentTool, { issue: 1, body: "x" }))).toBe("no_repo");
  expect(codeOf(await run(unset.editTool, { issue: 1, state: "closed" }))).toBe("no_repo");
  expect(unset.gitea.seen).toEqual([]);
});

test("one issue is read whole, with its labels and body; a number that is not there is not_found", async () => {
  const { getTool } = await setup({ repo: "Team/App", seeds: SEEDS });
  const read = await run(getTool, { issue: 1 });
  expect(codeOf(read)).toBe("read");
  const text = textOf(read);
  for (const fact of ["#1", "登录页报错", "open", "alice", "bug", "点登录就白屏"]) expect(text).toContain(fact);
  expect(codeOf(await run(getTool, { issue: 99 }))).toBe("not_found");
});

test("a comment is posted signed with who asked, and its address comes back", async () => {
  const { gitea, commentTool, getTool } = await setup({ repo: "Team/App", seeds: SEEDS });
  const posted = await run(commentTool, { issue: 1, body: "已复现 " });
  expect(codeOf(posted)).toBe("commented");
  expect(textOf(posted)).toContain("#issuecomment-");
  const sent = gitea.seen.at(-1);
  expect(sent?.path).toBe("/api/v1/repos/Team/App/issues/1/comments");
  const body = (sent?.body as { body: string } | undefined)?.body ?? "";
  expect(body.startsWith("已复现")).toBe(true);
  expect(body).toContain("小王");
  const read = await run(getTool, { issue: 1 });
  expect(textOf(read)).toContain("2 comments");
});

test("a comment on a missing issue is not_found; an empty or too long one is not sent; a broken answer is uncertain", async () => {
  const { gitea, commentTool } = await setup({ repo: "Team/App", seeds: SEEDS, timeoutMs: 100 });
  expect(codeOf(await run(commentTool, { issue: 99, body: "x" }))).toBe("not_found");
  const sentBefore = gitea.seen.length;
  expect(codeOf(await run(commentTool, { issue: 1, body: "  " }))).toBe("invalid_input");
  expect(codeOf(await run(commentTool, { issue: 1, body: "x".repeat(MAX_ISSUE_BODY_CHARS + 1) }))).toBe("invalid_input");
  expect(gitea.seen.length).toBe(sentBefore);
  for (const [answer, code] of [
    [{ status: 403 }, "repo_unavailable"],
    [{ status: 422 }, "invalid_input"],
    [{ status: 400 }, "failed"],
    [{ status: 500 }, "uncertain"],
    ["hang", "uncertain"],
  ] as const) {
    gitea.commentAnswers.push(answer as never);
    expect(codeOf(await run(commentTool, { issue: 1, body: "x" }))).toBe(code);
  }
});

test("an edit closes, retitles and rewrites; the result names the end state", async () => {
  const { gitea, editTool, getTool } = await setup({ repo: "Team/App", seeds: SEEDS });
  const closed = await run(editTool, { issue: 2, state: "closed", title: "导出按钮点击无反应" });
  expect(codeOf(closed)).toBe("updated");
  const text = textOf(closed);
  expect(text).toContain("closed");
  expect(text).toContain("title changed");
  const sent = gitea.seen.at(-1);
  expect(sent?.method).toBe("PATCH");
  expect(sent?.body).toEqual({ title: "导出按钮点击无反应", state: "closed" });
  const read = await run(getTool, { issue: 2 });
  expect(textOf(read)).toContain("State: closed");
  const reopened = await run(editTool, { issue: 2, state: "open", body: "新的正文" });
  expect(codeOf(reopened)).toBe("updated");
  expect(textOf(await run(getTool, { issue: 2 }))).toContain("新的正文");
});

test("an edit with nothing to change, a bad title or a missing issue sends nothing or is not_found; a broken Gitea is failed, never uncertain", async () => {
  const { gitea, editTool } = await setup({ repo: "Team/App", seeds: SEEDS, timeoutMs: 100 });
  expect(codeOf(await run(editTool, { issue: 1 }))).toBe("invalid_input");
  expect(codeOf(await run(editTool, { issue: 1, title: " \n" }))).toBe("invalid_input");
  expect(codeOf(await run(editTool, { issue: 1, title: "x".repeat(MAX_ISSUE_TITLE_CHARS + 1) }))).toBe("invalid_input");
  expect(gitea.seen).toEqual([]);
  expect(codeOf(await run(editTool, { issue: 99, state: "closed" }))).toBe("not_found");
  gitea.editAnswers.push({ status: 500 });
  expect(codeOf(await run(editTool, { issue: 1, state: "closed" }))).toBe("failed");
  gitea.editAnswers.push("hang");
  expect(codeOf(await run(editTool, { issue: 1, state: "closed" }))).toBe("failed");
});

test("a read that Gitea breaks is failed and names no issues; a refused token is an error for the operator", async () => {
  const { gitea, listTool } = await setup({ repo: "Team/App", seeds: SEEDS });
  gitea.readAnswers.push({ status: 500, message: `broke ${FAKE_GITEA_TOKEN}` });
  const lines = await captureLogs(async () => {
    const failed = await run(listTool, {});
    expect(codeOf(failed)).toBe("failed");
    expect(textOf(failed)).not.toContain("登录页报错");
  });
  expect(lines.map(({ line }) => line).join("\n")).not.toContain(FAKE_GITEA_TOKEN);
  await records?.close();
  records = undefined;
  await gitea.stop();

  const refused = await setup({ repo: "Team/App", token: "wrong-token" });
  const refusedLines = await captureLogs(async () => {
    expect(codeOf(await run(refused.listTool, {}))).toBe("failed");
  });
  expect(refusedLines.some(({ line, level }) => level === "error" && line.includes("gitea.list_failed") && line.includes("status=401"))).toBe(true);
});
