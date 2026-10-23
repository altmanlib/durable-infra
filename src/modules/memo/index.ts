import { section } from "@earendil-works/pi-durable";

import type { Module } from "../../kernel/module.ts";
import type { PromptSource } from "../../kernel/prompts.ts";
import { isShared } from "../../kernel/service/shared-tools.ts";
import { createDeleteMemoTool, createGetMemoTool, createListMemosTool, createSetMemoTool, MEMO_TOOLS } from "./memo.ts";
import { MEMO_PROMPTS } from "./prompts.ts";
import { type MemoStore, openMemoEntries } from "./records/index.ts";

export { MEMO_PROMPTS } from "./prompts.ts";

/** What the memo is for and that what it holds is information; said in shared conversations only, which are the ones offered the tools. */
export const memoSection = (prompts: PromptSource) =>
  section("memo", async ({ read, conversationId }) => ((await isShared(read, conversationId)) ? prompts.get("system.memo") : undefined), { tag: false });

/** The memo of a shared conversation, kept in the business database (domain `memo`): everyone there may read and write it. */
export function memoModule(): Module {
  let memos: MemoStore | undefined;
  return {
    name: "memo",
    prompts: MEMO_PROMPTS,
    toolSpecs: MEMO_TOOLS.map((name) => ({ name, scope: "shared-only" as const })),
    async prepare({ records }) {
      memos = await openMemoEntries(records);
      return [];
    },
    contribute: ({ prompts }) => {
      if (!memos) throw new Error("the memo module was used before it was prepared");
      const deps = { memos, prompts };
      return {
        tools: [createListMemosTool(deps), createGetMemoTool(deps), createSetMemoTool(deps), createDeleteMemoTool(deps)],
        sections: [memoSection(prompts)],
      };
    },
  };
}
