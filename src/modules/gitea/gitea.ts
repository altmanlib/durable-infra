import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ConversationSettings, SettingSpec } from "../../kernel/conversation-settings/index.ts";
import type { PromptSource } from "../../kernel/prompts.ts";
import { keyOf } from "../../kernel/service/conversation-key.ts";
import { speakerOf } from "../../kernel/service/shared-tools.ts";
import { log } from "../../platform/log.ts";
import { type GiteaClient, GiteaError } from "./client.ts";
import type { GiteaRepoRef } from "./settings.ts";
import { issueSignature } from "./texts.ts";

/**
 * Filing an issue on the group's Gitea repository (docs/design/2026-10-20-gitea-issue.md §5): open to everyone in a
 * group for now, deferred so only shared conversations are offered it, installed only when Gitea is configured.
 */
export const GITEA_CREATE_ISSUE = "gitea_create_issue";

export const MAX_ISSUE_TITLE_CHARS = 200;
export const MAX_ISSUE_BODY_CHARS = 10_000;

/** What the issue tool needs: the client of the bot account, and the setting it reads the repository from. */
export type GiteaTools = { client: GiteaClient; repo: SettingSpec<GiteaRepoRef> };

const coded = (code: string, message: string) => ({ output: [{ type: "text" as const, text: message }], details: { code } });
const error = (code: string, message: string) => ({ isError: true as const, ...coded(code, message) });

const NOT_FILED = "No issue was filed. Tell the user plainly; do not say it was filed.";

/** What a failure of `createIssue` comes to: the code, and whether the issue may exist anyway. */
function outcomeOf(cause: unknown): { code: "repo_unavailable" | "invalid_input" | "failed" | "uncertain"; kind: string; status?: number; detail?: string } {
  if (!(cause instanceof GiteaError)) return { code: "uncertain", kind: "unknown" };
  const seen = { kind: cause.kind, ...(cause.status === undefined ? {} : { status: cause.status }), ...(cause.detail ? { detail: cause.detail } : {}) };
  const status = cause.status;
  // Not answered, cut off, or broken inside Gitea: it may have filed the issue before that.
  if (cause.kind !== "status" || status === undefined || status >= 500) return { code: "uncertain", ...seen };
  if ((status >= 300 && status < 400) || status === 403 || status === 404 || status === 423) return { code: "repo_unavailable", ...seen };
  if (status === 422) return { code: "invalid_input", ...seen };
  return { code: "failed", ...seen };
}

const answers = {
  repo_unavailable: () =>
    error(
      "repo_unavailable",
      `The bot cannot file issues in this group's repository now: it may have been renamed, deleted or archived, or the bot's account removed from it or not allowed to. ${NOT_FILED} Someone allowed to change settings should check gitea.repo, or ask the operator.`,
    ),
  invalid_input: () => error("invalid_input", `Gitea did not accept this title or body. ${NOT_FILED} Rewrite it and try again.`),
  failed: () => error("failed", `Gitea refused to file the issue. ${NOT_FILED} The user may try again later, or ask the operator.`),
  uncertain: () =>
    error(
      "uncertain",
      "It is not known whether the issue was filed: Gitea did not answer in time, the connection broke, or Gitea failed inside. Do not say it was filed, and do not try again: ask the user to look in the repository first.",
    ),
};

export function createGiteaIssueTool(deps: { settings: ConversationSettings; prompts: PromptSource; gitea: GiteaTools }) {
  return defineTool({
    name: GITEA_CREATE_ISSUE,
    description: deps.prompts.get("tool.gitea_create_issue.description"),
    parameters: Type.Object({
      title: Type.String({ description: deps.prompts.get("tool.gitea_create_issue.title") }),
      body: Type.String({ description: deps.prompts.get("tool.gitea_create_issue.body") }),
    }),
    deferred: true,
    // Filing twice files two issues; an interrupted call is reported to the model instead.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const key = await keyOf(api, context);
      if (key === undefined) return error("no_conversation", "Issues cannot be filed from this conversation.");
      const started = Date.now();
      let ref: GiteaRepoRef | undefined;
      try {
        ref = await deps.settings.get(key, deps.gitea.repo);
      } catch (cause) {
        log.error("gitea.issue_failed", { key, code: "failed", kind: "storage", ms: Date.now() - started }, cause);
        return error("failed", `The group's settings could not be read. ${NOT_FILED}`);
      }
      if (ref === undefined)
        return error("no_repo", "This group has no Gitea repository set (gitea.repo), so no issue was filed. Someone allowed to change settings may set it.");

      const title = args.title.replace(/\s*[\r\n]+\s*/g, " ").trim();
      if (title === "") return error("invalid_input", "The title is empty. Give the issue a one-line title.");
      if (title.length > MAX_ISSUE_TITLE_CHARS)
        return error("invalid_input", `The title is at most ${MAX_ISSUE_TITLE_CHARS} characters; this one has ${title.length}. Shorten it.`);
      if (args.body.length > MAX_ISSUE_BODY_CHARS)
        return error("invalid_input", `The body is at most ${MAX_ISSUE_BODY_CHARS} characters; this one has ${args.body.length}. Shorten it.`);

      const repo = `${ref.owner}/${ref.repo}`;
      const speaker = await speakerOf(api, api.conversationId).catch(() => undefined);
      const by = speaker?.id ?? "";
      const signature = issueSignature(speaker?.name || speaker?.id);
      const body = args.body.trim() === "" ? signature : `${args.body.trimEnd()}\n\n${signature}`;
      try {
        const issue = await deps.gitea.client.createIssue(ref.owner, ref.repo, { title, body }, context.abortSignal);
        log.info("gitea.issue_created", { key, repo, number: issue.number, by, ms: Date.now() - started });
        return coded("created", `Filed issue #${issue.number} in ${repo}: ${issue.url}`);
      } catch (cause) {
        const outcome = outcomeOf(cause);
        const fields = { key, repo, code: outcome.code, kind: outcome.kind, status: outcome.status, detail: outcome.detail, by, ms: Date.now() - started };
        // A refused token is the operator's to fix.
        if (outcome.status === 401) log.error("gitea.issue_failed", fields);
        else log.warn("gitea.issue_failed", fields);
        return answers[outcome.code]();
      }
    },
  });
}
