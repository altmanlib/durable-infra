/**
 * Who may import what: the layers of docs/design/2026-10-20-infra-extraction.md §4.1 as one table, checked by
 * architecture.test.ts.
 *
 * Every source file under src/ belongs to exactly one zone: the zone with the longest path that covers it. A file may
 * import the files of its own zone, and the paths its zone lists in `uses`; nothing else under src/. A zone below
 * another is a zone of its own: the broader zone reaches into it only by listing it. A package that
 * some zone lists in `packages` belongs to those zones only; any other package (node:*, bun:test, …) is free.
 *
 * Tests (`*.test.ts`, and the fixtures under a `testing/` directory) may also reach across their own layer, use any
 * `testing/` fixture and `@earendil-works/pi-ai` (for faux models), and whatever their zone lists in `testUses`.
 *
 * Paths here are relative to src/. A path covers itself and, as a directory, everything below it; `uses` may also name
 * a zone, which stands for all its paths.
 */

export type Zone = {
  name: string;
  /** What the zone covers; defaults to its name. */
  paths?: string[];
  /** Why the zone is where it is: shown with every violation. */
  why: string;
  uses?: string[];
  packages?: string[];
  testUses?: string[];
  /** Not held to any rule: tooling. */
  free?: boolean;
};

const DURABLE = ["@earendil-works/pi-durable", "@earendil-works/chord", "@earendil-works/pi-ai"];

/** What the kernel offers a module: the module contract, the texts, the session machinery a tool needs, the settings. */
const MODULE_API = [
  "kernel/module.ts",
  "kernel/prompts.ts",
  "kernel/service/host.ts",
  "kernel/service/notices.ts",
  "kernel/service/shared-tools.ts",
  "kernel/service/conversation-key.ts",
  "kernel/service/transcript.ts",
  "kernel/conversation-settings/index.ts",
  "platform",
];

/** What the kernel's own parts may use of each other's foundations. */
const KERNEL_BASE = ["kernel/config.ts", "kernel/prompts.ts", "kernel/app-docs.ts", "platform"];

/** A module: only the kernel's module API and the platform; never another module, in its tests either. */
function module(name: string, why: string, extra: Partial<Zone> = {}): Zone {
  return { name: `modules/${name}`, why, uses: MODULE_API, testUses: ["kernel", "platform/records"], packages: DURABLE, ...extra };
}

/** The kernel's tests open real modules and a real database as fixtures, so they may use them. */
const KERNEL_TESTS = ["modules", "platform/records"];

export const ZONES: Zone[] = [
  // ---- platform: below everything, knows no one ----
  {
    name: "platform",
    // Listed one by one: platform/records is a zone of its own that only the few who open or take the database may reach.
    paths: ["platform/index.ts", "platform/log.ts", "platform/log-file.ts", "platform/sliding-window.ts", "platform/throttle.ts", "platform/local-time.ts"],
    why: "platform is below everything that runs on the server: the log, the in-process counters and the local time. It knows no one in the package and not Durable",
  },
  {
    name: "platform/records",
    paths: ["platform/records"],
    why: "records holds the business database and none of its tables: it knows no one above it; bun:sqlite is its alone, Kysely it shares only with the domains that own tables",
    uses: ["platform"],
    packages: ["bun:sqlite", "kysely"],
  },

  // ---- kernel: sessions, settings, queries; it knows no module ----
  {
    name: "kernel",
    why: "a file at the top of the kernel that is not listed below is held like a foundation",
    uses: KERNEL_BASE,
    testUses: KERNEL_TESTS,
    packages: DURABLE,
  },
  {
    name: "kernel/index.ts",
    why: "the public surface of the kernel",
    uses: ["kernel", "platform", "platform/records"],
    packages: DURABLE,
  },
  {
    name: "kernel/open.ts",
    why: "the assembly: it opens the records, the settings and the service and puts the modules in, so it may use all of the kernel",
    uses: ["kernel", "platform", "platform/records"],
    testUses: KERNEL_TESTS,
    packages: DURABLE,
  },
  {
    name: "kernel/module.ts",
    why: "the contract a module fulfils: types only, over the records, the settings and the texts",
    uses: ["kernel", "platform/records"],
    packages: DURABLE,
  },
  {
    name: "kernel/base",
    paths: ["kernel/config.ts", "kernel/prompts.ts", "kernel/app-docs.ts"],
    why: "config.ts, prompts.ts and app-docs.ts are foundations: everything in the kernel may use them, they use nothing else of it",
    uses: ["platform"],
    packages: DURABLE,
  },
  {
    name: "kernel/settings",
    why: "what the console changes; it sits below the service, which opens it, and knows neither the service nor the queries",
    uses: KERNEL_BASE,
    testUses: ["kernel/service"],
    packages: DURABLE,
  },
  {
    name: "kernel/service",
    why: "sessions and a turn: the machinery every channel and every tool uses; it knows no module, no query",
    uses: [...KERNEL_BASE, "kernel/settings"],
    testUses: [...KERNEL_TESTS, "kernel/conversation-settings", "kernel/index.ts"],
    packages: DURABLE,
  },
  {
    name: "kernel/insights",
    why: "insights reads stored data through the service, and the log files by the names log-file.ts gives them",
    uses: [...KERNEL_BASE, "kernel/service"],
    packages: DURABLE,
  },
  {
    name: "kernel/conversation-settings",
    why: "the settings of a conversation: the catalog the modules that own a setting register in, and its rows through the index of its records; it knows none of its settings",
    uses: [...KERNEL_BASE, "kernel/conversation-settings/records/index.ts"],
    testUses: ["platform/records"],
  },
  {
    name: "kernel/conversation-settings/records",
    why: "the settings' table in the business database: besides records, a place that knows Kysely, whose types stay inside",
    uses: [...KERNEL_BASE, "platform/records"],
    packages: ["kysely"],
  },

  // ---- modules: each one stands alone ----
  module("clock", "the time and the application status: read-only facts"),
  module("reminder", "reminders: a task that waits and leaves a notice for the channel", {
    uses: [...MODULE_API, "kernel/service/notices.ts"],
  }),
  module("web", "fetching a page and searching the web, with the libraries that read a page", {
    packages: [...DURABLE, "@mozilla/readability", "linkedom", "turndown"],
  }),
  module("memo", "the memo of a shared conversation, through the index of its table", {
    uses: [...MODULE_API, "modules/memo/records/index.ts"],
    testUses: ["kernel", "platform/records"],
  }),
  {
    name: "modules/memo/records",
    why: "the memo's table in the business database: besides records, a place that knows Kysely, whose types stay inside",
    uses: ["platform", "platform/records"],
    packages: ["kysely"],
  },
  module("settings-tools", "looking at and changing the settings of a conversation"),
  module("gitea", "filing an issue on the Gitea of a group: the client, the setting and the tool"),

  // ---- testing and tooling ----
  {
    name: "testing",
    why: "fixtures for tests, and the tools of all the modules built from plain dependencies; they are the one place that sees everything",
    uses: ["kernel", "modules", "platform", "platform/records"],
    packages: DURABLE,
  },
  {
    name: "scripts",
    paths: ["architecture.ts", "architecture.test.ts"],
    why: "the checker of the layers is not held to them",
    free: true,
  },
];

// ---- the checker ----

export type Import = { from: string; specifier: string };

function covers(path: string, file: string): boolean {
  return file === path || file.startsWith(`${path}/`);
}

function pathsOf(zone: Zone): string[] {
  return zone.paths ?? [zone.name];
}

/** The zone a file belongs to: the one with the longest path covering it; a test with none goes with the file it tests. */
export function zoneOf(file: string, zones: Zone[] = ZONES): Zone | undefined {
  let best: { zone: Zone; length: number } | undefined;
  for (const zone of zones)
    for (const path of pathsOf(zone)) if (covers(path, file) && (!best || path.length > best.length)) best = { zone, length: path.length };
  if (!best && /\.test\.tsx?$/.test(file)) return zoneOf(file.replace(/\.test(\.tsx?)$/, "$1"), zones);
  return best?.zone;
}

/** What a `uses` entry stands for: a zone by its name (all its paths), or else a path. */
function expand(entry: string, zones: Zone[]): string[] {
  const zone = zones.find((candidate) => candidate.name === entry);
  return zone ? pathsOf(zone) : [entry];
}

function reaches(entries: string[] | undefined, target: string, zones: Zone[]): boolean {
  return (entries ?? []).some((entry) => expand(entry, zones).some((path) => covers(path, target)));
}

export function isTest(file: string): boolean {
  return /\.test\.tsx?$/.test(file) || file.split("/").includes("testing");
}

/** The layer a zone is part of: the first directory (`kernel`, `modules`, `platform`, `testing`). Tests may reach across their own layer. */
function layerOf(file: string): string {
  return file.split("/")[0] as string;
}

function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

function matchesPackage(pattern: string, name: string): boolean {
  return pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/** Resolves a relative specifier against the importing file, both relative to src/. */
export function resolveFrom(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** Why an import breaks the layers, or undefined when it does not. */
export function violation({ from, specifier }: Import, zones: Zone[] = ZONES): string | undefined {
  const zone = zoneOf(from, zones);
  if (!zone) return `${from} is in no zone: add it to ZONES in src/architecture.ts`;
  if (zone.free) return undefined;
  const test = isTest(from);
  const explain = (what: string) => `${from} imports ${specifier}: ${what} (${zone.name}: ${zone.why})`;

  if (!specifier.startsWith(".")) {
    const name = packageOf(specifier);
    const owners = zones.filter((owner) => owner.packages?.some((pattern) => matchesPackage(pattern, name)));
    if (owners.length === 0) return undefined;
    if (owners.includes(zone)) return undefined;
    if (test && (name === "@earendil-works/pi-ai" || owners.some((owner) => pathsOf(owner).some((path) => layerOf(path) === layerOf(from))))) return undefined;
    // Name the layers that own it; within one of those layers, the zones, since that is where the line runs.
    const layers = [...new Set(owners.map((owner) => layerOf(pathsOf(owner)[0] as string)))];
    const named = layers.includes(layerOf(from)) ? owners.map((owner) => owner.name) : layers;
    return explain(`${name} belongs to ${named.join(", ")}`);
  }

  const target = resolveFrom(from, specifier);
  // The package's own package.json (release metadata); anything else outside src/ is refused below.
  if (target === "package.json") return undefined;
  if (target.startsWith("..")) return explain("it reaches outside src/");
  if (zoneOf(target, zones) === zone) return undefined;
  if (reaches(zone.uses, target, zones)) return undefined;
  // A test may reach across its own layer, except in `modules`: there the layer is many, and none uses another.
  if (test && ((layerOf(target) === layerOf(from) && layerOf(from) !== "modules") || isTest(target) || reaches(zone.testUses, target, zones))) return undefined;
  return explain(`${zone.name} may use ${zone.uses?.join(", ") || "nothing outside itself"}`);
}
