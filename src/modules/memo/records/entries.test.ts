import { afterEach, expect, test } from "bun:test";
import { Records } from "../../../platform/records/records.ts";
import { MAX_MEMO_BODY_CHARS, MAX_MEMO_ENTRIES, type MemoEntries, normalizeMemoName, previewOf } from "./entries.ts";
import { openMemoEntries } from "./index.ts";

let records: Records | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
});

let clock = 1_000;
async function open(): Promise<MemoEntries> {
  records = await Records.open(":memory:");
  clock = 1_000;
  return openMemoEntries(records, { now: () => clock });
}

test("a name is trimmed and its inner whitespace collapsed; nothing left, or too long, is no name", () => {
  expect(normalizeMemoName("  项目   概况\t\n表 ")).toBe("项目 概况 表");
  expect(normalizeMemoName("   ")).toBeUndefined();
  expect(normalizeMemoName("")).toBeUndefined();
  expect(normalizeMemoName("a".repeat(64))).toBe("a".repeat(64));
  expect(normalizeMemoName("a".repeat(65))).toBeUndefined();
  // Spaces around do not count towards the limit.
  expect(normalizeMemoName(`  ${"a".repeat(64)}  `)).toBe("a".repeat(64));
});

test("a preview is the first line that is not blank, cut with an ellipsis", () => {
  expect(previewOf("\n\n  # 标题  \n正文")).toBe("# 标题");
  expect(previewOf("")).toBe("");
  expect(previewOf("x".repeat(100))).toBe(`${"x".repeat(80)}…`);
});

test("set writes an entry under its normalized name, and get finds it however the name is spaced", async () => {
  const memos = await open();
  expect(await memos.set("feishu:oc_1", " 项目  概况 ", "# 概况\n第一期", "ou_a")).toBe("saved");
  expect(await memos.get("feishu:oc_1", "项目 概况")).toEqual({ name: "项目 概况", body: "# 概况\n第一期", updatedAt: 1_000, updatedBy: "ou_a" });
  expect(await memos.get("feishu:oc_1", "项目\t概况")).toBeDefined();
  expect(await memos.get("feishu:oc_1", "别的")).toBeUndefined();
  expect(await memos.get("feishu:oc_1", "  ")).toBeUndefined();
});

test("set replaces an entry of the same name as a whole, with the new time and writer", async () => {
  const memos = await open();
  await memos.set("k", "表", "old", "ou_a");
  clock = 2_000;
  expect(await memos.set("k", "表", "new", "")).toBe("saved");
  expect(await memos.get("k", "表")).toEqual({ name: "表", body: "new", updatedAt: 2_000, updatedBy: "" });
  expect((await memos.list("k")).length).toBe(1);
});

test("conversations do not see each other's entries", async () => {
  const memos = await open();
  await memos.set("a", "x", "of a", "");
  await memos.set("b", "x", "of b", "");
  expect((await memos.get("a", "x"))?.body).toBe("of a");
  expect((await memos.list("b")).map((entry) => entry.preview)).toEqual(["of b"]);
  expect(await memos.remove("a", "x")).toBe("deleted");
  expect((await memos.get("b", "x"))?.body).toBe("of b");
});

test("set refuses a name that cannot be kept and a body over the limit, and writes nothing", async () => {
  const memos = await open();
  expect(await memos.set("k", "   ", "x", "")).toBe("invalid_name");
  expect(await memos.set("k", "a".repeat(65), "x", "")).toBe("invalid_name");
  expect(await memos.set("k", "big", "x".repeat(MAX_MEMO_BODY_CHARS + 1), "")).toBe("too_large");
  expect(await memos.set("k", "full", "x".repeat(MAX_MEMO_BODY_CHARS), "")).toBe("saved");
  expect(await memos.set("k", "empty", "", "")).toBe("saved");
  expect((await memos.list("k")).map((entry) => entry.name).sort()).toEqual(["empty", "full"]);
});

test("a conversation keeps at most the limit of entries: a new name over it is refused, replacing one is not", async () => {
  const memos = await open();
  for (let index = 0; index < MAX_MEMO_ENTRIES; index++) expect(await memos.set("k", `n${index}`, "x", "")).toBe("saved");
  expect(await memos.set("k", "one more", "x", "")).toBe("too_many");
  expect(await memos.set("k", "n7", "changed", "")).toBe("saved");
  // Another conversation has its own limit.
  expect(await memos.set("other", "n0", "x", "")).toBe("saved");
  expect(await memos.remove("k", "n0")).toBe("deleted");
  expect(await memos.set("k", "one more", "x", "")).toBe("saved");
  expect((await memos.list("k")).length).toBe(MAX_MEMO_ENTRIES);
});

test("remove deletes an entry; a second remove, or of a name never written, is missing and no failure", async () => {
  const memos = await open();
  await memos.set("k", "表", "x", "");
  expect(await memos.remove("k", " 表 ")).toBe("deleted");
  expect(await memos.remove("k", "表")).toBe("missing");
  expect(await memos.remove("k", "never")).toBe("missing");
  expect(await memos.remove("k", "   ")).toBe("missing");
  expect(await memos.get("k", "表")).toBeUndefined();
});

test("list gives every entry of the conversation, the one written last first, with a preview and no body", async () => {
  const memos = await open();
  expect(await memos.list("k")).toEqual([]);
  await memos.set("k", "b", `\n${"长".repeat(90)}\nmore`, "ou_a");
  clock = 3_000;
  await memos.set("k", "a", "first line\nsecond", "ou_b");
  clock = 2_000;
  await memos.set("k", "c", "", "");
  expect(await memos.list("k")).toEqual([
    { name: "a", updatedAt: 3_000, updatedBy: "ou_b", preview: "first line" },
    { name: "c", updatedAt: 2_000, updatedBy: "", preview: "" },
    { name: "b", updatedAt: 1_000, updatedBy: "ou_a", preview: `${"长".repeat(80)}…` },
  ]);
});

test("a write that fails throws instead of passing for saved", async () => {
  const memos = await open();
  await records?.close();
  records = undefined;
  await expect(memos.set("k", "x", "y", "")).rejects.toThrow();
  await expect(memos.remove("k", "x")).rejects.toThrow();
});
