import type { Models } from "@earendil-works/pi-ai";
import type { Extension, ModelRef } from "@earendil-works/pi-durable";
import type { Records } from "../platform/records/records.ts";
import type { ConversationSettings, SettingSpec } from "./conversation-settings/index.ts";
import type { PromptEntries, PromptSource } from "./prompts.ts";
import type { ExtensionHost } from "./service/host.ts";

/** What every module can use, whatever it adds. */
export type BaseDeps = ExtensionHost & {
  now: () => Date;
  /** When the application started (taken once when the core opened). */
  startedAt: Date;
  /** The application version, as released. */
  version: string;
  /** The texts in force: descriptions of the tools and their parameters, and whatever else the module says to the model. */
  prompts: PromptSource;
};

/** What a module gets when the core opens, before the conversation settings do. */
export type PrepareContext = {
  /** The business database: a module with a table opens it here, with `records.tables(domain, migrations)`. */
  records: Records;
  prompts: PromptSource;
  /** The model the conversations use, for a module that calls a model itself, such as the page summaries. */
  models: Models;
  model: ModelRef;
};

/** What a module gets when the extension is built: the settings are open by then, and so is the Harness. */
export type ContributeContext = BaseDeps & {
  settings: ConversationSettings;
};

/** The parts of the one `builtin-tools` extension that a module adds. */
export type Contribution = Pick<Extension, "tools" | "sections" | "tasks">;

/**
 * A feature that an application opens or leaves out: it brings its tools, its texts and, when it needs them, a table and
 * settings, and nothing else in the core knows it. The modules of an
 * application are listed once, in the order their tools should appear; a module never uses another.
 *
 * Tool names, task names, prompt ids and table names of a module are persistent identifiers: conversations, stored
 * edits and the database refer to them, so never rename a published one.
 */
export interface Module {
  readonly name: string;
  /** The texts the module owns, in the catalog's words; their ids start with `tool.<name of a tool>` or `system.<module>`. */
  readonly prompts?: PromptEntries;
  /** Tools every member of a shared conversation may use, by name. */
  readonly sharedTools?: readonly string[];
  /** Tools a shared conversation also has, but only a privileged asker may call. */
  readonly privilegedTools?: readonly string[];
  /** Runs once when the core opens. Returns the conversation settings the module owns, if any. */
  prepare?(context: PrepareContext): Promise<readonly SettingSpec<unknown>[]>;
  /** Called when the extension is built, once per open. */
  contribute(context: ContributeContext): Contribution;
}
