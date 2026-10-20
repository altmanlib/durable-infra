import type { Models } from "@earendil-works/pi-ai";
import { defineExtension, type ModelRef } from "@earendil-works/pi-durable";
import { log } from "../platform/log.ts";
import { Records } from "../platform/records/records.ts";
import { CLIPROXY_PROVIDER, type CoreConfig, createCliproxyModels } from "./config.ts";
import { openConversationSettings, type SettingSpec } from "./conversation-settings/index.ts";
import { Insights } from "./insights/insights.ts";
import { LogReader } from "./insights/logs.ts";
import type { Contribution, Module } from "./module.ts";
import { EditablePrompts, KERNEL_PROMPTS, PromptCatalog, type PromptEntries, type PromptSource } from "./prompts.ts";
import { AgentService, type AgentServiceOptions } from "./service/agent-service.ts";
import type { ChangeLog } from "./settings/change-log.ts";
import type { Settings } from "./settings/settings.ts";

/**
 * What an entry process gets from the core: `agent` for the channels, `insights`, `settings` and `logs` (the log files)
 * for the query API, and `prompts`, the editable texts in force, for the channels' welcome texts. `records`, the business
 * database, in which a channel opens its own tables with `records.tables(domain, migrations)`, and whose health the query
 * API reports. They are closed together with `close()`, once the channels have stopped writing.
 */
export type Core = {
  agent: AgentService;
  insights: Insights;
  settings: Settings;
  prompts: PromptSource;
  logs: LogReader;
  records: Records;
  /** Close the session storage and the records. Call it after the channels stopped: they may still be writing until then. */
  close(): Promise<void>;
};

/** The service options the core fills in itself; everything else about the service the application may set. */
type ServiceOptions = Omit<AgentServiceOptions, "databasePath" | "models" | "model" | "prompts" | "extensions" | "sharedTools" | "privilegedTools">;

export type OpenCoreOptions = {
  config: CoreConfig;
  /** The application version, as released; the modules may report it. */
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
  /**
   * Where the application keeps the history of changes, made from the business database once that is open (`records`).
   * Without it the history is a Durable document; with it the allowlist and `Settings.channel` are not available
   * (see `AgentServiceOptions.changes`).
   */
  changes?: (records: Records) => ChangeLog | Promise<ChangeLog>;
  /** The models the conversations use, instead of the OpenAI-compatible gateway that `config` describes; for tests and other gateways. */
  llm?: { models: Models; model: ModelRef };
  now?: () => Date;
};

/** The one Durable extension the modules' tools, sections and tasks are put in; its name is stored by conversations. */
export const BUILTIN_EXTENSION = "builtin-tools";

/** Open the core on the configured storage and model, with the modules the application chose. */
export async function openCore(options: OpenCoreOptions): Promise<Core> {
  const { config, modules = [] } = options;
  const now = options.now ?? (() => new Date());
  // The start time `app_status` reports; taken once here so both entry processes share the meaning.
  const startedAt = now();
  // One source for every editable text; the edits stored by the console are loaded into it when the storage opens.
  const catalog = new PromptCatalog(
    [KERNEL_PROMPTS, ...modules.flatMap((module) => (module.prompts ? [module.prompts] : [])), ...(options.prompts?.entries ? [options.prompts.entries] : [])],
    options.prompts?.replace,
  );
  const prompts = new EditablePrompts(catalog);
  const records = await Records.open(config.recordsPath);
  try {
    const models = options.llm?.models ?? createCliproxyModels(config);
    const model = options.llm?.model ?? { provider: CLIPROXY_PROVIDER, modelId: config.modelId };
    // Before the tools are built, and whether or not a channel starts, so a module always finds its table.
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
    const sharedTools = modules.flatMap((module) => module.sharedTools ?? []);
    const privilegedTools = modules.flatMap((module) => module.privilegedTools ?? []);
    const changes = await options.changes?.(records);
    const agent = await AgentService.open({
      ...options.service,
      ...(changes ? { changes } : {}),
      databasePath: config.databasePath,
      models,
      model,
      prompts,
      // Without any, a shared conversation has every tool; with them, only these (kernel/service/shared-tools.ts).
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
    // A module's table, the settings' table or the session storage did not open: do not leave the records open.
    await records.close();
    throw error;
  }
}
