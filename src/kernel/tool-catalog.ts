/** What the modules offer, read from their declarations alone, so shared-conversation tool names and the operator's list cannot differ. */

import type { Module, ToolSpec } from "./module.ts";

/** One tool as an operator reads it. */
export type ToolRow = {
  module: string;
  name: string;
  /** The default text of `tool.<name>.description`; an edit made in the console is not applied. */
  description: string;
  /** Offered in a conversation of one person. */
  private: boolean;
  /** In a shared conversation: every member (`anyone`), only a privileged asker, or not offered there at all. */
  group: "anyone" | "privileged" | "none";
  /** Declared but not installed with this configuration. */
  off: boolean;
  note?: string;
};

export type ToolCatalog = { modules: string[]; tools: ToolRow[] };

const specsOf = (modules: readonly Module[]): { module: Module; spec: ToolSpec }[] =>
  modules.flatMap((module) => (module.toolSpecs ?? []).map((spec) => ({ module, spec })));

/** The names a shared conversation is given: `shared` for every member, `privileged` for privileged askers only; off tools are left out. */
export function sharedToolNames(modules: readonly Module[]): { shared: string[]; privileged: string[] } {
  const installed = specsOf(modules)
    .map(({ spec }) => spec)
    .filter((spec) => !spec.off);
  return {
    shared: installed.filter((spec) => (spec.access ?? "anyone") === "anyone").map((spec) => spec.name),
    privileged: installed.filter((spec) => spec.access === "privileged").map((spec) => spec.name),
  };
}

/** Every tool the modules declare, in the order the application listed them. */
export function describeTools(modules: readonly Module[]): ToolCatalog {
  const tools = specsOf(modules).map(({ module, spec }): ToolRow => {
    const off = spec.off === true;
    const row: ToolRow = {
      module: module.name,
      name: spec.name,
      description: module.prompts?.[`tool.${spec.name}.description`]?.text ?? "",
      private: !off && (spec.scope ?? "everywhere") === "everywhere",
      group: off ? "none" : (spec.access ?? "anyone"),
      off,
    };
    if (spec.note !== undefined) row.note = spec.note;
    return row;
  });
  return { modules: modules.map((module) => module.name), tools };
}

const SUMMARY_CHARS = 72;

/** The first sentence of a description, cut to a line. */
function summaryOf(description: string): string {
  const first = description.split(/(?<=[.!?。])\s/)[0] ?? "";
  return first.length > SUMMARY_CHARS ? `${first.slice(0, SUMMARY_CHARS - 1)}…` : first;
}

/** The catalog as a terminal table, or as JSON for a program. */
export function formatToolCatalog(catalog: ToolCatalog, options: { json?: boolean } = {}): string {
  if (options.json) return `${JSON.stringify(catalog, null, 2)}\n`;
  const head = `Modules: ${catalog.modules.length > 0 ? catalog.modules.join(", ") : "(none)"}\n`;
  if (catalog.tools.length === 0) return `${head}\nNo tools.\n`;
  const cells = catalog.tools.map((row) => {
    const summary = row.off ? `(${row.note ?? "off"})` : [summaryOf(row.description), row.note ? `(${row.note})` : ""].filter(Boolean).join(" ");
    return [row.name, row.off ? "-" : row.private ? "yes" : "no", row.group === "none" ? "-" : row.group, row.module, summary];
  });
  const table = [["TOOL", "PRIVATE", "GROUP", "MODULE", "SUMMARY"], ...cells];
  const widths = [0, 1, 2, 3].map((column) => Math.max(...table.map((line) => line[column]?.length ?? 0)));
  const lines = table.map((line) => [...widths.map((width, column) => (line[column] ?? "").padEnd(width)), line[4] ?? ""].join("  ").trimEnd());
  return `${head}\n${lines.join("\n")}\n`;
}
