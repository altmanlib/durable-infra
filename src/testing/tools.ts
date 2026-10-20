// The tools of all the modules built from plain dependencies, for tests that open a service directly instead of through
// `openCore`: no database, no model, no network unless a test supplies one. The names a shared conversation has are the
// modules' own declarations, so they cannot drift from what `openCore` passes.
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { BUILTIN_EXTENSION } from "../kernel/open.ts";
import type { AgentExtension } from "../kernel/service/host.ts";
import { createAppStatusTool } from "../modules/clock/app-status.ts";
import { createClockTool } from "../modules/clock/clock.ts";
import { clockModule } from "../modules/clock/index.ts";
import {
  createGiteaIssueCommentTool,
  createGiteaIssueEditTool,
  createGiteaIssueGetTool,
  createGiteaIssueListTool,
  createGiteaIssueTool,
} from "../modules/gitea/gitea.ts";
import { giteaModule } from "../modules/gitea/module.ts";
import { memoModule, memoSection } from "../modules/memo/index.ts";
import { createDeleteMemoTool, createGetMemoTool, createListMemosTool, createSetMemoTool } from "../modules/memo/memo.ts";
import { reminderModule } from "../modules/reminder/index.ts";
import { noRemindersSection } from "../modules/reminder/no-reminders.ts";
import { createCancelReminderTool, createListRemindersTool, createReminderTool, Remind } from "../modules/reminder/reminder.ts";
import { settingsToolsModule } from "../modules/settings-tools/index.ts";
import { createClearSettingTool, createListSettingsTool, createSetSettingTool, settingsSection } from "../modules/settings-tools/settings.ts";
import { webModule } from "../modules/web/index.ts";
import { webContentSection } from "../modules/web/web-content.ts";
import { createWebFetchTool } from "../modules/web/web-fetch.ts";
import { createWebSearchTool } from "../modules/web/web-search.ts";
import type { TestDeps } from "./testing.ts";

export type AllDeps = TestDeps;

/** Every module as an application that lists them all would, only for what they declare. */
const declared = [
  clockModule(),
  reminderModule(),
  webModule(),
  memoModule(),
  settingsToolsModule(),
  giteaModule({ url: "https://git.example.test", token: "unused" }),
];

/** The tools every member of a shared conversation may use, by the modules' declarations. */
export const SHARED_TOOLS: readonly string[] = declared.flatMap((module) => module.sharedTools ?? []);

/** The tools that only a privileged asker may call in a shared conversation. */
export const PRIVILEGED_TOOLS: readonly string[] = declared.flatMap((module) => module.privilegedTools ?? []);

/** In the order `openCore` registers them for a full list of modules. */
export function builtinTools(deps: AllDeps): ToolRegistration[] {
  return [
    createClockTool(deps),
    createAppStatusTool(deps),
    createReminderTool(deps),
    createListRemindersTool(deps),
    createCancelReminderTool(deps),
    createWebFetchTool(deps),
    ...(deps.search ? [createWebSearchTool({ search: deps.search, prompts: deps.prompts })] : []),
    createListMemosTool(deps),
    createGetMemoTool(deps),
    createSetMemoTool(deps),
    createDeleteMemoTool(deps),
    ...(deps.settings.catalog.empty ? [] : [createListSettingsTool(deps), createSetSettingTool(deps), createClearSettingTool(deps)]),
    ...(deps.gitea
      ? [
          createGiteaIssueTool({ settings: deps.settings, prompts: deps.prompts, gitea: deps.gitea }),
          createGiteaIssueListTool({ settings: deps.settings, prompts: deps.prompts, gitea: deps.gitea }),
          createGiteaIssueGetTool({ settings: deps.settings, prompts: deps.prompts, gitea: deps.gitea }),
          createGiteaIssueCommentTool({ settings: deps.settings, prompts: deps.prompts, gitea: deps.gitea }),
          createGiteaIssueEditTool({ settings: deps.settings, prompts: deps.prompts, gitea: deps.gitea }),
        ]
      : []),
  ];
}

/** The one extension the tools are in, as `openCore` installs it. */
export function builtinExtensions(deps: AllDeps): AgentExtension[] {
  return [
    {
      name: BUILTIN_EXTENSION,
      tools: builtinTools(deps),
      sections: [webContentSection(deps.prompts), noRemindersSection(deps.prompts), memoSection(deps.prompts), settingsSection(deps.prompts)],
      tasks: [Remind],
    },
  ];
}
