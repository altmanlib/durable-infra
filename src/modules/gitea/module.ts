import type { SettingSpec } from "../../kernel/conversation-settings/index.ts";
import type { Module } from "../../kernel/module.ts";
import { log } from "../../platform/log.ts";
import { GiteaHttpClient } from "./client.ts";
import { createGiteaIssueTool, GITEA_CREATE_ISSUE, type GiteaTools } from "./gitea.ts";
import { GITEA_PROMPTS } from "./prompts.ts";
import { giteaRepoSetting } from "./settings.ts";

export type GiteaConfig = {
  /** The root address, without `/api/v1` and without a trailing slash, such as `https://git.example.com`. */
  url: string;
  token: string;
};

/** BOT_GITEA_URL and BOT_GITEA_TOKEN: both or neither; the address must be http(s). Throws naming the variable. */
export function giteaConfigFromEnv(env: Record<string, string | undefined>): GiteaConfig | undefined {
  const url = env.BOT_GITEA_URL?.trim() ?? "";
  const token = env.BOT_GITEA_TOKEN?.trim() ?? "";
  if (url === "" && token === "") return undefined;
  if (url === "") throw new Error("BOT_GITEA_URL is required when BOT_GITEA_TOKEN is set");
  if (token === "") throw new Error("BOT_GITEA_TOKEN is required when BOT_GITEA_URL is set");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("BOT_GITEA_URL must be an http or https address");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    throw new Error("BOT_GITEA_URL must be an http or https address without query, fragment or credentials");
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, token };
}

/**
 * Filing an issue on the Gitea of a group (docs/design/2026-10-20-gitea-issue.md): the setting `gitea.repo` and the
 * tool that uses it. An application that has no Gitea does not list the module.
 */
export function giteaModule(config: GiteaConfig): Module {
  const client = new GiteaHttpClient({ baseUrl: config.url, token: config.token });
  const gitea: GiteaTools = { client, repo: giteaRepoSetting(client, config.url) };
  return {
    name: "gitea",
    prompts: GITEA_PROMPTS,
    sharedTools: [GITEA_CREATE_ISSUE],
    async prepare() {
      log.info("gitea.configured", { host: new URL(config.url).host });
      return [gitea.repo as SettingSpec<unknown>];
    },
    contribute: ({ settings, prompts }) => ({ tools: [createGiteaIssueTool({ settings, prompts, gitea })] }),
  };
}
