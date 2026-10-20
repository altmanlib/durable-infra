import type { SettingCheck, SettingSpec } from "../../kernel/conversation-settings/index.ts";
import { log } from "../../platform/log.ts";
import { type GiteaClient, GiteaError } from "./client.ts";

/** The repository a group files its issues in, as stored: Gitea's `owner/name`. */
export type GiteaRepoRef = { owner: string; repo: string };

/** One segment of `owner/repo`: Gitea's characters, never `.` or `..` (the client encodes it as well). */
const SEGMENT = /^(?!\.{1,2}$)[\w.-]+$/;

const invalid = (): SettingCheck => ({ ok: false, code: "invalid_value", reason: "Write it as owner/repo, or as an address of this group's Gitea." });
const rejected = (reason: string): SettingCheck => ({ ok: false, code: "rejected", reason });

/** `owner/repo` from what someone typed: the pair itself, or an address on the configured Gitea; `undefined` otherwise. */
export function repoOf(input: string, baseUrl: string): GiteaRepoRef | undefined {
  let path = input.trim();
  if (/^https?:\/\//i.test(path)) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      return undefined;
    }
    const base = new URL(baseUrl);
    // Only the configured Gitea: the same host, whichever scheme was copied.
    if (url.host !== base.host) return undefined;
    const prefix = base.pathname.replace(/\/+$/, "");
    if (!url.pathname.startsWith(`${prefix}/`)) return undefined;
    path = url.pathname.slice(prefix.length + 1);
  }
  path = path.replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = path.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts as [string, string];
  return SEGMENT.test(owner) && SEGMENT.test(repo) ? { owner, repo } : undefined;
}

/**
 * The setting `gitea.repo`: checked against Gitea when it is set, kept as
 * Gitea's `owner/name`. Every reason is a fixed text: nothing Gitea answered reaches the model.
 */
export function giteaRepoSetting(client: GiteaClient, baseUrl: string): SettingSpec<GiteaRepoRef> {
  return {
    name: "gitea.repo",
    summary: "The Gitea repository this group files issues in.",
    format: "owner/repo, e.g. team/app",
    unset: "not set: issues cannot be filed until someone sets it",
    check: async (input, { signal }) => {
      const ref = repoOf(input, baseUrl);
      if (!ref) return invalid();
      let found: Awaited<ReturnType<GiteaClient["repo"]>>;
      try {
        found = await client.repo(ref.owner, ref.repo, signal);
      } catch (error) {
        // The token is refused or lacks a scope: for the operator. The settings answer check_failed either way.
        if (error instanceof GiteaError && (error.status === 401 || error.status === 403))
          log.error("gitea.auth_failed", { repo: `${ref.owner}/${ref.repo}`, status: error.status, detail: error.detail });
        throw error;
      }
      if (found === "missing")
        return rejected(
          "There is no such repository, or the bot's Gitea account cannot see it: for a private repository, add the bot account as a collaborator or to a team of the organization.",
        );
      if (found === "moved") return rejected("The repository or its owner was renamed or moved: set it again with the new name.");
      if (found.archived) return rejected("The repository is archived, so no issue can be filed in it.");
      if (!found.internalTracker) return rejected("The repository does not use Gitea's own issues (they are off, or an external tracker is set).");
      return { ok: true, value: found.fullName };
    },
    decode: (stored) => {
      const parts = stored.split("/");
      if (parts.length !== 2) return undefined;
      const [owner, repo] = parts as [string, string];
      return SEGMENT.test(owner) && SEGMENT.test(repo) ? { owner, repo } : undefined;
    },
  };
}
