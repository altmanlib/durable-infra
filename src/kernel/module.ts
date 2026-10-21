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
 * What a module says about one of its tools, apart from the tool itself: where it is offered and who may call it. This is
 * the one place that says so; the names a shared conversation is given and the listing of an application's tools are
 * both read from it.
 */
export type ToolSpec = {
  /** The tool's name, which is persistent. */
  readonly name: string;
  /**
   * Where the tool is offered. `everywhere` (the default): every conversation, a one-to-one one included. `shared-only`:
   * a conversation several people share, such as a group; the tool is `deferred`, so a conversation that has every tool
   * is not offered it.
   */
  readonly scope?: "everywhere" | "shared-only";
  /**
   * Who may call it in a shared conversation. `anyone` (the default): every member. `privileged`: only a run whose
   * inputs were all sent `privileged`, since the tool changes state. A one-to-one conversation is not checked.
   */
  readonly access?: "anyone" | "privileged";
  /** Not installed with this configuration, such as a search tool without a search service; `note` says why. */
  readonly off?: true;
  /** What an operator reading the list should know: why the tool is off, or what else it depends on. */
  readonly note?: string;
};

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
  /**
   * The tools the module brings, as the application would configure them. Each tool `contribute` returns is declared
   * here (a test holds the two together), and a tool that is `off` is declared but not returned.
   */
  readonly toolSpecs?: readonly ToolSpec[];
  /** Runs once when the core opens. Returns the conversation settings the module owns, if any. */
  prepare?(context: PrepareContext): Promise<readonly SettingSpec<unknown>[]>;
  /** Called when the extension is built, once per open. */
  contribute(context: ContributeContext): Contribution;
}
