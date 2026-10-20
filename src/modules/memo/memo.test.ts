import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { ConversationKeys } from "../../kernel/service/notices.ts";
import { Outbox } from "../../kernel/service/outbox.ts";
import { Records } from "../../platform/records/records.ts";
import { captureLogs, defaultPrompts, toolDeps } from "../../testing/testing.ts";
import { builtinTools, SHARED_TOOLS } from "../../testing/tools.ts";
import { createDeleteMemoTool, createGetMemoTool, createListMemosTool, createSetMemoTool, MEMO_TOOLS } from "./memo.ts";
import { type MemoEntries, type MemoStore, openMemoEntries } from "./records/index.ts";

let records: Records | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
});

async function realMemos(): Promise<MemoEntries> {
  records = await Records.open(":memory:");
  return openMemoEntries(records);
}

/**
 * What a tool reads of the session: the conversation's channel key (none when `key` is undefined), and the current run's
 * input matched to a privileged outbox item of `asker`, when given.
 */
function api(key: string | undefined, asker?: string) {
  return {
    conversationId: 7,
    snapshot: async (definition: unknown) => {
      if (definition === ConversationKeys) return key === undefined ? undefined : { key };
      if (definition === LiveDoc) return asker ? { run: { inputs: [11] } } : undefined;
      if (definition === Outbox) return { items: asker ? [{ key, requestId: "r", text: "t", speaker: { id: asker }, submission: 11, privileged: true }] : [] };
      return undefined;
    },
  } as never;
}

const tools = (memos: MemoStore) => {
  const deps = { memos, prompts: defaultPrompts };
  return { list: createListMemosTool(deps), get: createGetMemoTool(deps), set: createSetMemoTool(deps), remove: createDeleteMemoTool(deps) };
};

type Result = { output?: { type: string; text?: string }[]; details?: unknown; isError?: boolean };
const codeOf = (result: Result) => (result.details as { code?: string } | undefined)?.code;
const textOf = (result: Result) => (result.output ?? []).map((part) => part.text ?? "").join("");

const run = (tool: { execute: (...args: never[]) => unknown }, args: Record<string, unknown>, on = api("feishu:oc_1")) =>
  (tool.execute as (args: unknown, api: unknown, context: unknown) => Promise<Result>)(args, on, BACKGROUND_CONTEXT);

test("the four memo tools are installed for everyone in a group, not privileged, read-only ones safe to replay, and deferred", () => {
  const installed = builtinTools(toolDeps()).filter((tool) => (MEMO_TOOLS as readonly string[]).includes(tool.name));
  expect(installed.map((tool) => tool.name)).toEqual([...MEMO_TOOLS]);
  for (const tool of installed) expect([tool.name, tool.replay, tool.deferred]).toEqual([tool.name, "safe", true]);
  expect(SHARED_TOOLS).toEqual(expect.arrayContaining([...MEMO_TOOLS]));
});

test("set, get, list and delete answer with their codes", async () => {
  const memos = await realMemos();
  const memo = tools(memos);
  expect(codeOf(await run(memo.list, {}))).toBe("listed");
  const saved = await run(memo.set, { name: " 项目  概况 ", body: "# 概况\n第一期上线" });
  expect([codeOf(saved), saved.isError]).toEqual(["saved", undefined]);
  expect(textOf(saved)).toContain("项目 概况");

  const read = await run(memo.get, { name: "项目 概况" });
  expect([codeOf(read), read.isError]).toEqual(["read", undefined]);
  expect(textOf(read)).toContain("第一期上线");

  const listed = await run(memo.list, {});
  expect(codeOf(listed)).toBe("listed");
  expect(textOf(listed)).toContain("项目 概况");
  expect(textOf(listed)).toContain("# 概况");

  expect(codeOf(await run(memo.remove, { name: "项目 概况" }))).toBe("deleted");
  const again = await run(memo.remove, { name: "项目 概况" });
  // Deleting what is not there is no failure.
  expect([codeOf(again), again.isError]).toEqual(["missing", undefined]);
  const gone = await run(memo.get, { name: "项目 概况" });
  expect([codeOf(gone), gone.isError]).toEqual(["missing", true]);
});

test("set refuses what cannot be kept with a code of its own", async () => {
  const memo = tools(await realMemos());
  expect(codeOf(await run(memo.set, { name: "   ", body: "x" }))).toBe("invalid_name");
  expect(codeOf(await run(memo.set, { name: "big", body: "x".repeat(8001) }))).toBe("too_large");
  for (let index = 0; index < 50; index++) await run(memo.set, { name: `n${index}`, body: "x" });
  const full = await run(memo.set, { name: "one more", body: "x" });
  expect([codeOf(full), full.isError]).toEqual(["too_many", true]);
});

test("the writer is the asker the outbox knows, else empty", async () => {
  const memos = await realMemos();
  const memo = tools(memos);
  await run(memo.set, { name: "a", body: "x" }, api("feishu:oc_1", "ou_boss"));
  await run(memo.set, { name: "b", body: "x" });
  expect((await memos.get("feishu:oc_1", "a"))?.updatedBy).toBe("ou_boss");
  expect((await memos.get("feishu:oc_1", "b"))?.updatedBy).toBe("");
});

test("each conversation reads only its own memo, by its channel key; one without a key has none", async () => {
  const memo = tools(await realMemos());
  await run(memo.set, { name: "a", body: "of group 1" }, api("feishu:oc_1"));
  expect(codeOf(await run(memo.get, { name: "a" }, api("feishu:oc_2")))).toBe("missing");
  for (const [tool, args] of [
    [memo.list, {}],
    [memo.get, { name: "a" }],
    [memo.set, { name: "a", body: "x" }],
    [memo.remove, { name: "a" }],
  ] as const) {
    const result = await run(tool, args, api(undefined));
    expect([codeOf(result), result.isError]).toEqual(["no_conversation", true]);
  }
});

test("storage that fails is a failure the model is told of, never a success, and is logged", async () => {
  const broken: MemoStore = {
    list: async () => Promise.reject(new Error("disk")),
    get: async () => Promise.reject(new Error("disk")),
    set: async () => Promise.reject(new Error("SQLITE_FULL")),
    remove: async () => Promise.reject(new Error("disk")),
  };
  const memo = tools(broken);
  const lines = await captureLogs(async () => {
    for (const [tool, args] of [
      [memo.list, {}],
      [memo.get, { name: "a" }],
      [memo.set, { name: "a", body: "x" }],
      [memo.remove, { name: "a" }],
    ] as const) {
      const result = await run(tool, args);
      expect([codeOf(result), result.isError]).toEqual(["failed", true]);
    }
  });
  expect(lines.filter(({ line, level }) => level === "error" && line.includes("memo.failed")).length).toBe(4);
});
