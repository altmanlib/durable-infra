import type { Models } from "@earendil-works/pi-ai";
import { defineExtension, type ModelRef } from "@earendil-works/pi-durable";
import { log } from "../platform/log.ts";
import { Records } from "../platform/records/records.ts";
import { CLIPROXY_PROVIDER, type CoreConfig, createCliproxyModels, type GatewayModel } from "./config.ts";
import { type ConversationSettings, openConversationSettings, type SettingSpec } from "./conversation-settings/index.ts";
import { Insights } from "./insights/insights.ts";
import { LogReader } from "./insights/logs.ts";
import type { Contribution, Module } from "./module.ts";
import { EditablePrompts, KERNEL_PROMPTS, PromptCatalog, type PromptEntries, type PromptSource } from "./prompts.ts";
import { AgentService, type AgentServiceOptions } from "./service/agent-service.ts";
import type { ChangeLog } from "./settings/change-log.ts";
import type { Settings } from "./settings/settings.ts";
import { sharedToolNames } from "./tool-catalog.ts";

/** What an entry process gets from the core; all are closed together by `close()` once the channels stop writing. */
export type Core = {
  agent: AgentService;
  insights: Insights;
  settings: Settings;
  prompts: PromptSource;
  /** Per-conversation settings, shared with the settings tools and modules. */
  conversationSettings: ConversationSettings;
  logs: LogReader;
  records: Records;
  /** Close storage and records; call after the channels stop writing. */
  close(): Promise<void>;
};

/** Service options the application may set; the rest are filled in by the core. */
type ServiceOptions = Omit<AgentServiceOptions, "databasePath" | "models" | "model" | "catalog" | "prompts" | "extensions" | "sharedTools" | "privilegedTools">;

export type OpenCoreOptions = {
  config: CoreConfig;
  /** The application version, as released. */
  version: string;
  /** The directory of the log files that `logs` reads. */
  logDir: string;
  /** The features the application has, in the order their tools should appear. */
  modules?: readonly Module[];
  prompts?: {
    /** Texts the application adds, such as the welcome of its channels. */
    entries?: PromptEntries;
    /** New default texts for ids that exist, such as the persona in `system.preamble`. */
    replace?: Readonly<Record<string, string | readonly string[]>>;
  };
  /** Options of the conversation service, such as the tool round limit. */
  service?: ServiceOptions;
  /** Change-history store, built from the business database (see `AgentServiceOptions.changes`). */
  changes?: (records: Records) => ChangeLog | Promise<ChangeLog>;
  /** Extra gateway models a conversation may move to via `setModel`; their ids are stored, so never rename one. Not used with `llm`. */
  extraModels?: readonly GatewayModel[];
  /** Models used instead of the gateway from `config`, for tests and other gateways; see `AgentServiceOptions.catalog`. */
  llm?: { models: Models; model: ModelRef; catalog?: readonly ModelRef[] };
  now?: () => Date;
};

/** The one Durable extension the modules' tools, sections and tasks are put in; its name is stored by conversations. */
export const BUILTIN_EXTENSION = "builtin-tools";

/** Open the core on the configured storage and model, with the modules the application chose. */
export async function openCore(options: OpenCoreOptions): Promise<Core> {
  const { config, modules = [] } = options;
  const now = options.now ?? (() => new Date());
  // Start time for `app_status`, taken once so both processes agree.
  const startedAt = now();
  // One source for every editable text.
  const catalog = new PromptCatalog(
    [KERNEL_PROMPTS, ...modules.flatMap((module) => (module.prompts ? [module.prompts] : [])), ...(options.prompts?.entries ? [options.prompts.entries] : [])],
    options.prompts?.replace,
  );
  const prompts = new EditablePrompts(catalog);
  const records = await Records.open(config.recordsPath);
  try {
    const models = options.llm?.models ?? createCliproxyModels(config, options.extraModels);
    const model = options.llm?.model ?? { provider: CLIPROXY_PROVIDER, modelId: config.modelId };
    const catalog = options.llm
      ? options.llm.catalog
      : [
          model,
          ...(options.extraModels ?? []).filter((extra) => extra.id !== model.modelId).map((extra) => ({ provider: CLIPROXY_PROVIDER, modelId: extra.id })),
        ];
    // Before the tools are built, so a module always finds its table.
    const specs: SettingSpec<unknown>[] = [];
    for (const module of modules) specs.push(...((await module.prepare?.({ records, prompts, models, model })) ?? []));
    const settings = await openConversationSettings(records, specs);
    log.info("setting.catalog", {
      count: settings.catalog.all().length,
      names: settings.catalog
        .all()
        .map((spec) => spec.name)
        .join(","),
    });
    const { shared: sharedTools, privileged: privilegedTools } = sharedToolNames(modules);
    const changes = await options.changes?.(records);
    const agent = await AgentService.open({
      ...options.service,
      ...(changes ? { changes } : {}),
      databasePath: config.databasePath,
      models,
      model,
      ...(catalog ? { catalog } : {}),
      prompts,
      // Without them, shared conversations have every tool (see shared-tools.ts).
      ...(sharedTools.length > 0 || privilegedTools.length > 0 ? { sharedTools, privilegedTools } : {}),
      extensions: (host) => {
        const parts: Contribution[] = modules.map((module) => module.contribute({ ...host, now, startedAt, version: options.version, prompts, settings }));
        return [
          defineExtension({
            name: BUILTIN_EXTENSION,
            tools: parts.flatMap((part) => part.tools ?? []),
            sections: parts.flatMap((part) => part.sections ?? []),
            tasks: parts.flatMap((part) => part.tasks ?? []),
          }),
        ];
      },
    });
    return {
      agent,
      insights: new Insights(agent.reader),
      settings: agent.settings,
      prompts,
      conversationSettings: settings,
      logs: new LogReader({ dir: options.logDir }),
      records,
      close: async () => {
        try {
          await agent.close();
        } finally {
          await records.close();
        }
      },
    };
  } catch (error) {
    // Do not leave the records open if a table or storage fails to open.
    await records.close();
    throw error;
  }
}
