// Filing issues on the team's Gitea: the module, and the client, the setting
// `gitea.repo` and the signature it is made of.

export { GITEA_TIMEOUT_MS, type GiteaClient, GiteaError, type GiteaErrorKind, GiteaHttpClient, type GiteaIssue, type GiteaRepo } from "./client.ts";
export { type GiteaConfig, giteaConfigFromEnv, giteaModule } from "./module.ts";
export { GITEA_PROMPTS } from "./prompts.ts";
export { type GiteaRepoRef, giteaRepoSetting, repoOf } from "./settings.ts";
export { issueSignature } from "./texts.ts";
