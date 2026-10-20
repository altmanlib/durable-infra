// Public surface of the kernel: what an application and its channels use. The log, the counters and the business
// database are in `./platform`, the features in `./modules/*`, the test fixtures in `./testing`.

export { CLIPROXY_PROVIDER, type CoreConfig, createCliproxyModels, loadCoreConfig } from "./config.ts";
export { ConversationSettings, SettingCatalog, type SettingSpec } from "./conversation-settings/index.ts";
export { Insights, type InsightsOptions, QueryError } from "./insights/insights.ts";
export { LOG_PAGE_MAX, LOG_TEXT_MAX, type LogEntry, type LogPage, type LogQuery, LogReader } from "./insights/logs.ts";
export type { DayRange, UsageCounters, UsageDay, UsageReport, UsageSource } from "./insights/usage.ts";
export type { BaseDeps, ContributeContext, Contribution, Module, PrepareContext } from "./module.ts";
export { BUILTIN_EXTENSION, type Core, type OpenCoreOptions, openCore } from "./open.ts";
export {
  defaultPrompts,
  EditablePrompts,
  entry,
  KERNEL_PROMPTS,
  type KernelPromptId,
  PromptCatalog,
  type PromptEffect,
  type PromptEntries,
  type PromptEntry,
  type PromptSource,
  promptsWith,
} from "./prompts.ts";
export {
  AgentService,
  type AgentServiceOptions,
  type ChannelService,
  type CompactOutcome,
  type ConversationInfo,
  type ConversationKey,
  type OwnsKey,
  type PendingTurn,
  type SendOptions,
  type Turn,
  TurnFailed,
} from "./service/agent-service.ts";
export {
  type AnswerTexts,
  answerText,
  type NoticeOptions,
  type NoticeService,
  type Notices,
  type ReplayOptions,
  type ReplayService,
  replayPending,
  type SendToKey,
  startNotices,
} from "./service/delivery.ts";
export type { AgentExtension, ExtensionHost } from "./service/host.ts";
export { isEvent, type Notice, type ScheduledEvent } from "./service/notices.ts";
export type { HistoryLine, Speaker } from "./service/transcript.ts";
export { ROUND_SEPARATOR, type ToolActivity } from "./service/turn-feed.ts";
export { AccessList, type AllowlistView, type ChannelAccess, type ChannelList, type DeniedUser } from "./settings/access.ts";
export type { Change } from "./settings/docs.ts";
export {
  type ChangePage,
  type ChannelDoc,
  type ChannelStore,
  type ChannelTx,
  MAX_PROMPT_CHARS,
  type PromptLock,
  type PromptView,
  Settings,
  SettingsError,
  type SettingsErrorKind,
} from "./settings/settings.ts";
