import type { Models } from "@earendil-works/pi-ai";
import type { Extension, ModelRef } from "@earendil-works/pi-durable";

import type { Records } from "../platform/records/records.ts";
import type { ConversationSettings, SettingSpec } from "./conversation-settings/index.ts";
import type { PromptEntries, PromptSource } from "./prompts.ts";
import type { ExtensionHost } from "./service/host.ts";

/** What every module can use, whatever it adds. */
export type BaseDeps = ExtensionHost & {
  now: () => Date;
  /** When the application started. */
  startedAt: Date;
  /** The application version, as released. */
  version: string;
  /** The texts in force, such as tool descriptions. */
  prompts: PromptSource;
};

/** What a module gets when the core opens, before the conversation settings do. */
export type PrepareContext = {
  /** Business database; a module with a table opens it here via `records.tables`. */
  records: Records;
  prompts: PromptSource;
  /** Models, for a module that calls one itself. */
  models: Models;
  model: ModelRef;
};

/** What a module gets when its extension is built; settings and the Harness are open by then. */
export type ContributeContext = BaseDeps & {
  settings: ConversationSettings;
};

/** The parts of the one `builtin-tools` extension that a module adds. */
export type Contribution = Pick<Extension, "tools" | "sections" | "tasks">;

/** Where and by whom a tool may be used, apart from the tool itself; the one place that says so. */
export type ToolSpec = {
  /** The tool's name, which is persistent. */
  readonly name: string;
  /** `everywhere` (default), or `shared-only` for shared conversations such as groups. */
  readonly scope?: "everywhere" | "shared-only";
  /** `anyone` (default), or `privileged`: only runs whose inputs were all sent `privileged`; one-to-one chats are not checked. */
  readonly access?: "anyone" | "privileged";
  /** Not installed with this configuration, such as a search tool without a search service; `note` says why. */
  readonly off?: true;
  /** Operator-facing note: why it is off, or what it depends on. */
  readonly note?: string;
};

/** An optional feature bringing its own tools, texts, and optionally a table and settings. Its persistent names (tools, tasks, prompt ids, tables) are never renamed once published. */
export interface Module {
  readonly name: string;
  /** Texts the module owns; ids start with `tool.<name>` or `system.<module>`. */
  readonly prompts?: PromptEntries;
  /** Declared tools; each tool `contribute` returns is declared here, and an `off` tool is declared but not returned. */
  readonly toolSpecs?: readonly ToolSpec[];
  /** Runs once when the core opens. Returns the conversation settings the module owns, if any. */
  prepare?(context: PrepareContext): Promise<readonly SettingSpec<unknown>[]>;
  /** Called when the extension is built, once per open. */
  contribute(context: ContributeContext): Contribution;
}
