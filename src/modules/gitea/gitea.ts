import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ConversationSettings, SettingSpec } from "../../kernel/conversation-settings/index.ts";
import type { PromptSource } from "../../kernel/prompts.ts";
import { type KeyedApi, keyOf } from "../../kernel/service/conversation-key.ts";
import { speakerOf } from "../../kernel/service/shared-tools.ts";
import { log } from "../../platform/log.ts";
import { type GiteaClient, GiteaError } from "./client.ts";
import type { GiteaRepoRef } from "./settings.ts";
import { commentSignature, issueSignature } from "./texts.ts";

/** The group's Gitea issue tools (file, list, read, comment, edit); deferred, so only shared conversations get them. */
export const GITEA_ISSUE_CREATE = "gitea_issue_create";
export const GITEA_ISSUE_LIST = "gitea_issue_list";
export const GITEA_ISSUE_GET = "gitea_issue_get";
export const GITEA_ISSUE_COMMENT_CREATE = "gitea_issue_comment_create";
export const GITEA_ISSUE_EDIT = "gitea_issue_edit";

export const MAX_ISSUE_TITLE_CHARS = 200;
export const MAX_ISSUE_BODY_CHARS = 10_000;

/** What the issue tool needs: the client of the bot account, and the setting it reads the repository from. */
export type GiteaTools = { client: GiteaClient; repo: SettingSpec<GiteaRepoRef> };

const coded = (code: string, message: string) => ({ output: [{ type: "text" as const, text: message }], details: { code } });
const error = (code: string, message: string) => ({ isError: true as const, ...coded(code, message) });

const NOT_FILED = "No issue was filed. Tell the user plainly; do not say it was filed.";

/** What of a failure the log keeps: its kind, and Gitea's status and message when it answered with one. */
function seenOf(cause: unknown): { kind: string; status?: number; detail?: string } {
  if (!(cause instanceof GiteaError)) return { kind: "unknown" };
  return { kind: cause.kind, ...(cause.status === undefined ? {} : { status: cause.status }), ...(cause.detail ? { detail: cause.detail } : {}) };
}

/** What a failure of `createIssue` comes to: the code, and whether the issue may exist anyway. */
function outcomeOf(cause: unknown): { code: "repo_unavailable" | "invalid_input" | "failed" | "uncertain"; kind: string; status?: number; detail?: string } {
  const seen = seenOf(cause);
  const status = seen.status;
  // Not answered, cut off, or broken inside Gitea: it may have filed the issue before that.
  if (seen.kind !== "status" || status === undefined || status >= 500) return { code: "uncertain", ...seen };
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

type GateTexts = { noConversation: string; settingsFailed: string; noRepo: string };

/** Gate for every issue tool: checks the conversation's key and repository; failures are answered in the tool's words. */
async function gate(
  deps: { settings: ConversationSettings; gitea: GiteaTools },
  api: KeyedApi,
  context: Context,
  event: string,
  texts: GateTexts,
): Promise<{ ok: true; key: string; ref: GiteaRepoRef; started: number } | { ok: false; result: ReturnType<typeof error> }> {
  const key = await keyOf(api, context);
  if (key === undefined) return { ok: false, result: error("no_conversation", texts.noConversation) };
  const started = Date.now();
  let ref: GiteaRepoRef | undefined;
  try {
    ref = await deps.settings.get(key, deps.gitea.repo);
  } catch (cause) {
    log.error(event, { key, code: "failed", kind: "storage", ms: Date.now() - started }, cause);
    return { ok: false, result: error("failed", texts.settingsFailed) };
  }
  if (ref === undefined) return { ok: false, result: error("no_repo", texts.noRepo) };
  return { ok: true, key, ref, started };
}

/** The issue number a call names, or undefined when it is not a positive whole number. */
const issueNumberOf = (value: number): number | undefined => (Number.isSafeInteger(value) && value >= 1 ? value : undefined);

export function createGiteaIssueTool(deps: { settings: ConversationSettings; prompts: PromptSource; gitea: GiteaTools }) {
  return defineTool({
    name: GITEA_ISSUE_CREATE,
    description: deps.prompts.get("tool.gitea_issue_create.description"),
    parameters: Type.Object({
      title: Type.String({ description: deps.prompts.get("tool.gitea_issue_create.title") }),
      body: Type.String({ description: deps.prompts.get("tool.gitea_issue_create.body") }),
    }),
    deferred: true,
    // Filing twice files two issues; an interrupted call is reported to the model instead.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const gated = await gate(deps, api, context, "gitea.issue_failed", {
        noConversation: "Issues cannot be filed from this conversation.",
        settingsFailed: `The group's settings could not be read. ${NOT_FILED}`,
        noRepo: "This group has no Gitea repository set (gitea.repo), so no issue was filed. Someone allowed to change settings may set it.",
      });
      if (!gated.ok) return gated.result;
      const { key, ref, started } = gated;

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

const NOT_LISTED = "No issues were listed. Tell the user plainly; do not invent any.";

/** What a failed read comes to: the repository is out of reach, or the read failed and may simply be tried again. */
function readOutcome(cause: unknown): { code: "repo_unavailable" | "failed"; kind: string; status?: number; detail?: string } {
  const seen = seenOf(cause);
  const status = seen.status;
  if (status !== undefined && ((status >= 300 && status < 400) || status === 403 || status === 404 || status === 423))
    return { code: "repo_unavailable", ...seen };
  return { code: "failed", ...seen };
}

const readAnswers = {
  repo_unavailable: (doing: string) =>
    error(
      "repo_unavailable",
      `The bot cannot ${doing} in this group's repository now: it may have been renamed, deleted or archived, or the bot's account removed from it or not allowed to. ${NOT_LISTED} Someone allowed to change settings should check gitea.repo, or ask the operator.`,
    ),
  failed: (doing: string) =>
    error("failed", `The bot could not ${doing} in this group's repository. Nothing was changed. The user may try again later, or ask the operator.`),
};

export const MAX_LIST_LIMIT = 50;
export const DEFAULT_LIST_LIMIT = 20;

export function createGiteaIssueListTool(deps: { settings: ConversationSettings; prompts: PromptSource; gitea: GiteaTools }) {
  return defineTool({
    name: GITEA_ISSUE_LIST,
    description: deps.prompts.get("tool.gitea_issue_list.description"),
    parameters: Type.Object({
      state: Type.Optional(
        Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")], { description: deps.prompts.get("tool.gitea_issue_list.state") }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT, description: deps.prompts.get("tool.gitea_issue_list.limit") })),
    }),
    deferred: true,
    // Reading changes nothing; an interrupted call may simply be run again.
    replay: "safe",
    execute: async (args, api, context) => {
      const gated = await gate(deps, api, context, "gitea.list_failed", {
        noConversation: "Issues cannot be listed from this conversation.",
        settingsFailed: `The group's settings could not be read. ${NOT_LISTED}`,
        noRepo: "This group has no Gitea repository set (gitea.repo), so there are no issues to list. Someone allowed to change settings may set it.",
      });
      if (!gated.ok) return gated.result;
      const { key, ref, started } = gated;
      const repo = `${ref.owner}/${ref.repo}`;
      const state = args.state ?? "open";
      const limit = args.limit ?? DEFAULT_LIST_LIMIT;
      try {
        const issues = await deps.gitea.client.listIssues(ref.owner, ref.repo, { state, limit }, context.abortSignal);
        log.info("gitea.issues_listed", { key, repo, state, count: issues.length, ms: Date.now() - started });
        if (issues.length === 0) return coded("listed", `There are no ${state === "all" ? "" : `${state} `}issues in ${repo}.`);
        const lines = issues.map((issue) => {
          const parts = [`#${issue.number} ${issue.title}`, issue.state, `by ${issue.author || "unknown"}`, `${issue.comments} comments`];
          if (issue.updatedAt !== "") parts.push(`updated ${issue.updatedAt.slice(0, 10)}`);
          return `${parts.join(" · ")} · ${issue.url}`;
        });
        return coded(
          "listed",
          [`${issues.length} ${state === "all" ? "" : `${state} `}issue${issues.length === 1 ? "" : "s"} in ${repo}, newest first:`, ...lines].join("\n"),
        );
      } catch (cause) {
        const outcome = readOutcome(cause);
        const fields = { key, repo, code: outcome.code, kind: outcome.kind, status: outcome.status, detail: outcome.detail, ms: Date.now() - started };
        if (outcome.status === 401) log.error("gitea.list_failed", fields);
        else log.warn("gitea.list_failed", fields);
        return readAnswers[outcome.code]("list issues");
      }
    },
  });
}

export function createGiteaIssueGetTool(deps: { settings: ConversationSettings; prompts: PromptSource; gitea: GiteaTools }) {
  return defineTool({
    name: GITEA_ISSUE_GET,
    description: deps.prompts.get("tool.gitea_issue_get.description"),
    parameters: Type.Object({
      issue: Type.Integer({ minimum: 1, description: deps.prompts.get("tool.gitea_issue_get.issue") }),
    }),
    deferred: true,
    replay: "safe",
    execute: async (args, api, context) => {
      const gated = await gate(deps, api, context, "gitea.read_failed", {
        noConversation: "Issues cannot be read from this conversation.",
        settingsFailed: `The group's settings could not be read. ${NOT_LISTED}`,
        noRepo: "This group has no Gitea repository set (gitea.repo), so there is no issue to read. Someone allowed to change settings may set it.",
      });
      if (!gated.ok) return gated.result;
      const { key, ref, started } = gated;
      const repo = `${ref.owner}/${ref.repo}`;
      const number = issueNumberOf(args.issue);
      if (number === undefined) return error("invalid_input", "The issue number must be a positive whole number.");
      try {
        const issue = await deps.gitea.client.getIssue(ref.owner, ref.repo, number, context.abortSignal);
        if (issue === "missing")
          return error("not_found", `There is no issue #${number} in ${repo}: the number may be wrong, or the issue was deleted. Nothing was read.`);
        log.info("gitea.issue_read", { key, repo, number, ms: Date.now() - started });
        const head = [`Issue #${issue.number} in ${repo}: ${issue.title}`];
        const facts = [
          `State: ${issue.state}`,
          `Opened by ${issue.author || "unknown"}${issue.createdAt === "" ? "" : ` on ${issue.createdAt.slice(0, 10)}`}`,
          `${issue.comments} comments`,
        ];
        if (issue.labels.length > 0) facts.push(`Labels: ${issue.labels.join(", ")}`);
        head.push(facts.join(" · "), issue.url);
        return coded("read", [...head, "", issue.body === "" ? "(no body)" : issue.body].join("\n"));
      } catch (cause) {
        const outcome = readOutcome(cause);
        const fields = { key, repo, number, code: outcome.code, kind: outcome.kind, status: outcome.status, detail: outcome.detail, ms: Date.now() - started };
        if (outcome.status === 401) log.error("gitea.read_failed", fields);
        else log.warn("gitea.read_failed", fields);
        return readAnswers[outcome.code]("read issues");
      }
    },
  });
}

const NOT_POSTED = "No comment was posted. Tell the user plainly; do not say it was posted.";

/** What a failure of `createComment` comes to: like filing, a comment whose call broke may exist anyway. */
function commentOutcome(cause: unknown): {
  code: "repo_unavailable" | "not_found" | "invalid_input" | "failed" | "uncertain";
  kind: string;
  status?: number;
  detail?: string;
} {
  const seen = seenOf(cause);
  const status = seen.status;
  if (seen.kind !== "status" || status === undefined || status >= 500) return { code: "uncertain", ...seen };
  if (status === 404) return { code: "not_found", ...seen };
  if ((status >= 300 && status < 400) || status === 403 || status === 423) return { code: "repo_unavailable", ...seen };
  if (status === 422) return { code: "invalid_input", ...seen };
  return { code: "failed", ...seen };
}

export function createGiteaIssueCommentTool(deps: { settings: ConversationSettings; prompts: PromptSource; gitea: GiteaTools }) {
  return defineTool({
    name: GITEA_ISSUE_COMMENT_CREATE,
    description: deps.prompts.get("tool.gitea_issue_comment_create.description"),
    parameters: Type.Object({
      issue: Type.Integer({ minimum: 1, description: deps.prompts.get("tool.gitea_issue_comment_create.issue") }),
      body: Type.String({ description: deps.prompts.get("tool.gitea_issue_comment_create.body") }),
    }),
    deferred: true,
    // Posting twice posts two comments; an interrupted call is reported to the model instead.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const gated = await gate(deps, api, context, "gitea.comment_failed", {
        noConversation: "Comments cannot be posted from this conversation.",
        settingsFailed: `The group's settings could not be read. ${NOT_POSTED}`,
        noRepo: "This group has no Gitea repository set (gitea.repo), so no comment was posted. Someone allowed to change settings may set it.",
      });
      if (!gated.ok) return gated.result;
      const { key, ref, started } = gated;
      const repo = `${ref.owner}/${ref.repo}`;
      const number = issueNumberOf(args.issue);
      if (number === undefined) return error("invalid_input", "The issue number must be a positive whole number.");
      if (args.body.trim() === "") return error("invalid_input", "The comment is empty. Write the comment's text.");
      if (args.body.length > MAX_ISSUE_BODY_CHARS)
        return error("invalid_input", `The comment is at most ${MAX_ISSUE_BODY_CHARS} characters; this one has ${args.body.length}. Shorten it.`);

      const speaker = await speakerOf(api, api.conversationId).catch(() => undefined);
      const by = speaker?.id ?? "";
      const signature = commentSignature(speaker?.name || speaker?.id);
      const body = `${args.body.trimEnd()}\n\n${signature}`;
      try {
        const comment = await deps.gitea.client.createComment(ref.owner, ref.repo, number, { body }, context.abortSignal);
        log.info("gitea.issue_commented", { key, repo, number, by, ms: Date.now() - started });
        return coded("commented", `Posted a comment on issue #${number} in ${repo}: ${comment.url}`);
      } catch (cause) {
        const outcome = commentOutcome(cause);
        const fields = {
          key,
          repo,
          number,
          code: outcome.code,
          kind: outcome.kind,
          status: outcome.status,
          detail: outcome.detail,
          by,
          ms: Date.now() - started,
        };
        if (outcome.status === 401) log.error("gitea.comment_failed", fields);
        else log.warn("gitea.comment_failed", fields);
        switch (outcome.code) {
          case "not_found":
            return error("not_found", `There is no issue #${number} in ${repo}, so no comment was posted. Check the number.`);
          case "repo_unavailable":
            return error(
              "repo_unavailable",
              `The bot cannot comment in this group's repository now: it may have been renamed, deleted or archived, or the bot's account removed from it or not allowed to. ${NOT_POSTED} Someone allowed to change settings should check gitea.repo, or ask the operator.`,
            );
          case "invalid_input":
            return error("invalid_input", `Gitea did not accept this comment. ${NOT_POSTED} Rewrite it and try again.`);
          case "failed":
            return error("failed", `Gitea refused the comment. ${NOT_POSTED} The user may try again later, or ask the operator.`);
          case "uncertain":
            return error(
              "uncertain",
              "It is not known whether the comment was posted: Gitea did not answer in time, the connection broke, or Gitea failed inside. Do not say it was posted, and do not try again: ask the user to look at the issue first.",
            );
        }
      }
    },
  });
}

const NOT_CHANGED = "Nothing was changed. Tell the user plainly; do not say it was changed.";

/** What a failure of `editIssue` comes to: an edit is idempotent, so a failure is never uncertain. */
function editOutcome(cause: unknown): { code: "repo_unavailable" | "not_found" | "invalid_input" | "failed"; kind: string; status?: number; detail?: string } {
  const seen = seenOf(cause);
  const status = seen.status;
  if (status === 404) return { code: "not_found", ...seen };
  if (status !== undefined && ((status >= 300 && status < 400) || status === 403 || status === 423)) return { code: "repo_unavailable", ...seen };
  if (status === 422) return { code: "invalid_input", ...seen };
  return { code: "failed", ...seen };
}

export function createGiteaIssueEditTool(deps: { settings: ConversationSettings; prompts: PromptSource; gitea: GiteaTools }) {
  return defineTool({
    name: GITEA_ISSUE_EDIT,
    description: deps.prompts.get("tool.gitea_issue_edit.description"),
    parameters: Type.Object({
      issue: Type.Integer({ minimum: 1, description: deps.prompts.get("tool.gitea_issue_edit.issue") }),
      title: Type.Optional(Type.String({ description: deps.prompts.get("tool.gitea_issue_edit.title") })),
      body: Type.Optional(Type.String({ description: deps.prompts.get("tool.gitea_issue_edit.body") })),
      state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")], { description: deps.prompts.get("tool.gitea_issue_edit.state") })),
    }),
    deferred: true,
    // An edit names the end state, so running it again changes nothing more.
    replay: "safe",
    execute: async (args, api, context) => {
      const gated = await gate(deps, api, context, "gitea.edit_failed", {
        noConversation: "Issues cannot be changed from this conversation.",
        settingsFailed: `The group's settings could not be read. ${NOT_CHANGED}`,
        noRepo: "This group has no Gitea repository set (gitea.repo), so nothing was changed. Someone allowed to change settings may set it.",
      });
      if (!gated.ok) return gated.result;
      const { key, ref, started } = gated;
      const repo = `${ref.owner}/${ref.repo}`;
      const number = issueNumberOf(args.issue);
      if (number === undefined) return error("invalid_input", "The issue number must be a positive whole number.");
      if (args.title === undefined && args.body === undefined && args.state === undefined)
        return error("invalid_input", "Nothing to change: give a new title, a new body, or a state (open or closed).");

      const patch: { title?: string; body?: string; state?: "open" | "closed" } = {};
      const changes: string[] = [];
      if (args.title !== undefined) {
        const title = args.title.replace(/\s*[\r\n]+\s*/g, " ").trim();
        if (title === "") return error("invalid_input", "The title is empty. Give the issue a one-line title, or leave the title out to keep it.");
        if (title.length > MAX_ISSUE_TITLE_CHARS)
          return error("invalid_input", `The title is at most ${MAX_ISSUE_TITLE_CHARS} characters; this one has ${title.length}. Shorten it.`);
        patch.title = title;
        changes.push("title changed");
      }
      if (args.body !== undefined) {
        if (args.body.trim() === "") return error("invalid_input", "The body is empty. Write the issue's body, or leave the body out to keep it.");
        if (args.body.length > MAX_ISSUE_BODY_CHARS)
          return error("invalid_input", `The body is at most ${MAX_ISSUE_BODY_CHARS} characters; this one has ${args.body.length}. Shorten it.`);
        patch.body = args.body;
        changes.push("body changed");
      }
      if (args.state !== undefined) {
        patch.state = args.state;
        changes.push(args.state === "closed" ? "closed" : "reopened");
      }

      const speaker = await speakerOf(api, api.conversationId).catch(() => undefined);
      const by = speaker?.id ?? "";
      try {
        const issue = await deps.gitea.client.editIssue(ref.owner, ref.repo, number, patch, context.abortSignal);
        log.info("gitea.issue_updated", { key, repo, number, by, ms: Date.now() - started });
        return coded("updated", `Updated issue #${number} in ${repo}: ${changes.join(", ")}. It is now ${issue.state}. ${issue.url}`);
      } catch (cause) {
        const outcome = editOutcome(cause);
        const fields = {
          key,
          repo,
          number,
          code: outcome.code,
          kind: outcome.kind,
          status: outcome.status,
          detail: outcome.detail,
          by,
          ms: Date.now() - started,
        };
        if (outcome.status === 401) log.error("gitea.edit_failed", fields);
        else log.warn("gitea.edit_failed", fields);
        switch (outcome.code) {
          case "not_found":
            return error("not_found", `There is no issue #${number} in ${repo}, so nothing was changed. Check the number.`);
          case "repo_unavailable":
            return error(
              "repo_unavailable",
              `The bot cannot change issues in this group's repository now: it may have been renamed, deleted or archived, or the bot's account removed from it or not allowed to. ${NOT_CHANGED} Someone allowed to change settings should check gitea.repo, or ask the operator.`,
            );
          case "invalid_input":
            return error("invalid_input", `Gitea did not accept this change. ${NOT_CHANGED} Rewrite it and try again.`);
          case "failed":
            return error("failed", `The change could not be made. ${NOT_CHANGED} Trying again is safe: the same change gives the same result.`);
        }
      }
    },
  });
}
