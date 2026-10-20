// The issue tools of the team's Gitea: the module, and the client, the setting
// `gitea.repo` and the signature it is made of.

export {
  GITEA_TIMEOUT_MS,
  type GiteaClient,
  type GiteaComment,
  GiteaError,
  type GiteaErrorKind,
  GiteaHttpClient,
  type GiteaIssue,
  type GiteaIssueDetail,
  type GiteaIssuePatch,
  type GiteaIssueState,
  type GiteaIssueSummary,
  type GiteaRepo,
} from "./client.ts";
export { type GiteaConfig, giteaConfigFromEnv, giteaModule } from "./module.ts";
export { GITEA_PROMPTS } from "./prompts.ts";
export { type GiteaRepoRef, giteaRepoSetting, repoOf } from "./settings.ts";
export { commentSignature, issueSignature } from "./texts.ts";
