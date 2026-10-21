import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { PromptSource } from "../../kernel/prompts.ts";
import { keyOf } from "../../kernel/service/conversation-key.ts";
import { askerOf } from "../../kernel/service/shared-tools.ts";
import { formatLocal } from "../../platform/local-time.ts";
import { log } from "../../platform/log.ts";
import { MAX_MEMO_BODY_CHARS, MAX_MEMO_ENTRIES, MAX_MEMO_NAME_CHARS, type MemoStore, normalizeMemoName } from "./records/index.ts";

/** The group's memo: entries in the business database. Deferred, so only shared conversations are offered its tools. */
export const MEMO_TOOLS = ["list_memos", "get_memo", "set_memo", "delete_memo"] as const;

const coded = (code: string, message: string) => ({ output: [{ type: "text" as const, text: message }], details: { code } });
const error = (code: string, message: string) => ({ isError: true as const, ...coded(code, message) });

const noConversation = () => error("no_conversation", "The memo is not available in this conversation.");
const failed = (doing: string) => error("failed", `The memo could not be ${doing}: storage failed. Tell the user plainly; do not say it was done.`);

type Deps = { memos: MemoStore; prompts: PromptSource };

export function createListMemosTool(deps: Deps) {
  return defineTool({
    name: "list_memos",
    description: deps.prompts.get("tool.list_memos.description"),
    parameters: Type.Object({}),
    deferred: true,
    replay: "safe",
    execute: async (_args, api, context) => {
      const key = await keyOf(api, context);
      if (key === undefined) return noConversation();
      let entries: Awaited<ReturnType<MemoStore["list"]>>;
      try {
        entries = await deps.memos.list(key);
      } catch (cause) {
        log.error("memo.failed", { key, action: "list" }, cause);
        return failed("read");
      }
      if (entries.length === 0) return coded("listed", "The memo has no entries yet.");
      const lines = entries.map((entry) => `- ${entry.name} (updated ${formatLocal(new Date(entry.updatedAt))})${entry.preview ? `: ${entry.preview}` : ""}`);
      return coded("listed", [`${entries.length} of at most ${MAX_MEMO_ENTRIES} entries, the one written last first:`, ...lines].join("\n"));
    },
  });
}

export function createGetMemoTool(deps: Deps) {
  return defineTool({
    name: "get_memo",
    description: deps.prompts.get("tool.get_memo.description"),
    parameters: Type.Object({ name: Type.String({ description: deps.prompts.get("tool.get_memo.name") }) }),
    deferred: true,
    replay: "safe",
    execute: async (args, api, context) => {
      const key = await keyOf(api, context);
      if (key === undefined) return noConversation();
      let entry: Awaited<ReturnType<MemoStore["get"]>>;
      try {
        entry = await deps.memos.get(key, args.name);
      } catch (cause) {
        log.error("memo.failed", { key, action: "get" }, cause);
        return failed("read");
      }
      if (entry === undefined) return error("missing", `The memo has no entry named "${args.name.trim()}". Use list_memos to see the names.`);
      const body = entry.body === "" ? "(empty)" : entry.body;
      return coded("read", `Entry "${entry.name}", updated ${formatLocal(new Date(entry.updatedAt))}:\n\n${body}`);
    },
  });
}

export function createSetMemoTool(deps: Deps) {
  return defineTool({
    name: "set_memo",
    description: deps.prompts.get("tool.set_memo.description"),
    parameters: Type.Object({
      name: Type.String({ description: deps.prompts.get("tool.set_memo.name") }),
      body: Type.String({ description: deps.prompts.get("tool.set_memo.body") }),
    }),
    deferred: true,
    // Writing the same entry again leaves the same row: an interrupted call may simply run again.
    replay: "safe",
    execute: async (args, api, context) => {
      const key = await keyOf(api, context);
      if (key === undefined) return noConversation();
      const name = normalizeMemoName(args.name);
      let result: Awaited<ReturnType<MemoStore["set"]>>;
      try {
        // Who asked, as the privileged tools hook finds them; empty when that is not known.
        const by = (await askerOf(api, api.conversationId)) ?? "";
        result = await deps.memos.set(key, args.name, args.body, by);
      } catch (cause) {
        log.error("memo.failed", { key, action: "set" }, cause);
        return failed("saved");
      }
      switch (result) {
        case "saved":
          log.info("memo.saved", { key, name: name ?? "", chars: args.body.length });
          return coded("saved", `Saved the entry "${name}".`);
        case "invalid_name":
          return error("invalid_name", `An entry name is 1 to ${MAX_MEMO_NAME_CHARS} characters, not counting the spaces around it.`);
        case "too_large":
          return error(
            "too_large",
            `An entry is at most ${MAX_MEMO_BODY_CHARS} characters; this one has ${args.body.length}. Shorten it or split it into entries.`,
          );
        case "too_many":
          return error("too_many", `The memo already has ${MAX_MEMO_ENTRIES} entries, the most it may. Delete one, or add this to an existing entry.`);
      }
    },
  });
}

export function createDeleteMemoTool(deps: Deps) {
  return defineTool({
    name: "delete_memo",
    description: deps.prompts.get("tool.delete_memo.description"),
    parameters: Type.Object({ name: Type.String({ description: deps.prompts.get("tool.delete_memo.name") }) }),
    deferred: true,
    // Deleting twice is harmless: the second finds nothing.
    replay: "safe",
    execute: async (args, api, context) => {
      const key = await keyOf(api, context);
      if (key === undefined) return noConversation();
      let result: Awaited<ReturnType<MemoStore["remove"]>>;
      try {
        result = await deps.memos.remove(key, args.name);
      } catch (cause) {
        log.error("memo.failed", { key, action: "delete" }, cause);
        return failed("deleted");
      }
      const name = normalizeMemoName(args.name) ?? args.name.trim();
      if (result === "missing") return coded("missing", `The memo has no entry named "${name}"; nothing to delete.`);
      log.info("memo.deleted", { key, name });
      return coded("deleted", `Deleted the entry "${name}".`);
    },
  });
}
