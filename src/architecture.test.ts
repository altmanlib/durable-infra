import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { Glob } from "bun";
import ts from "typescript";

import { type Import, isTest, violation, zoneOf, ZONES } from "./architecture.ts";

const SRC = new URL("./", import.meta.url).pathname;

const files = [...new Glob("**/*.{ts,tsx}").scanSync(SRC)].sort();

/** Every import of a file, type-only imports and re-exports included, as written. */
function importsOf(file: string): Import[] {
  const text = readFileSync(`${SRC}${file}`, "utf8");
  return ts.preProcessFile(text, true, true).importedFiles.map((imported) => ({ from: file, specifier: imported.fileName }));
}

test("every source file belongs to a zone, and every zone covers a file that exists", () => {
  expect(files.filter((file) => !zoneOf(file))).toEqual([]);
  const stale = ZONES.flatMap((zone) => zone.paths ?? [zone.name]).filter((path) => !existsSync(`${SRC}${path}`));
  expect(stale).toEqual([]);
  const names = ZONES.map((zone) => zone.name);
  expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
});

test("everything a zone uses is a zone or a path that exists", () => {
  const entries = ZONES.flatMap((zone) => [...(zone.uses ?? []), ...(zone.testUses ?? [])]);
  const names = new Set(ZONES.map((zone) => zone.name));
  expect([...new Set(entries)].filter((entry) => !names.has(entry) && !existsSync(`${SRC}${entry}`))).toEqual([]);
});

test("no import crosses the layers", () => {
  const found = files.flatMap((file) =>
    importsOf(file)
      .map((imported) => violation(imported))
      .filter((why) => why !== undefined),
  );
  expect(found).toEqual([]);
});

// The table is only worth what it catches: each of these breaks a rule that matters, and must be refused.
const BAD: Import[] = [
  // platform knows no one above it, and not Durable
  { from: "platform/throttle.ts", specifier: "../kernel/index.ts" },
  { from: "platform/sliding-window.ts", specifier: "@earendil-works/pi-durable" },
  { from: "platform/log.ts", specifier: "./records/records.ts" },
  // the business database: bun:sqlite is the records' alone, Kysely only the domains' that own tables
  { from: "kernel/service/agent-service.ts", specifier: "bun:sqlite" },
  { from: "kernel/service/agent-service.ts", specifier: "kysely" },
  { from: "kernel/service/agent-service.ts", specifier: "../../platform/records/records.ts" },
  { from: "modules/web/web-fetch.ts", specifier: "kysely" },
  { from: "platform/records/records.ts", specifier: "../../kernel/service/agent-service.ts" },
  // the kernel knows no module
  { from: "kernel/service/agent-service.ts", specifier: "../../modules/reminder/reminder.ts" },
  { from: "kernel/settings/settings.ts", specifier: "../../modules/memo/index.ts" },
  { from: "kernel/prompts.ts", specifier: "../modules/web/prompts.ts" },
  { from: "kernel/conversation-settings/settings.ts", specifier: "../../modules/gitea/index.ts" },
  // inside the kernel
  { from: "kernel/settings/settings.ts", specifier: "../service/agent-service.ts" },
  { from: "kernel/service/agent-service.ts", specifier: "../insights/insights.ts" },
  { from: "kernel/prompts.ts", specifier: "./settings/settings.ts" },
  { from: "kernel/config.ts", specifier: "./index.ts" },
  // a module stands alone: not another module, not the assembly, not the kernel's inside
  { from: "modules/gitea/gitea.ts", specifier: "../memo/memo.ts" },
  { from: "modules/web/web-fetch.ts", specifier: "../reminder/reminder.ts" },
  { from: "modules/clock/clock.ts", specifier: "../../kernel/open.ts" },
  { from: "modules/clock/clock.ts", specifier: "../../kernel/service/agent-service.ts" },
  { from: "modules/memo/memo.ts", specifier: "../../kernel/insights/insights.ts" },
  // the libraries that read a page are the web module's
  { from: "kernel/service/agent-service.ts", specifier: "linkedom" },
  { from: "modules/memo/memo.ts", specifier: "turndown" },
  // tests reach across their own layer and use the fixtures
  { from: "modules/gitea/gitea.test.ts", specifier: "../memo/memo.ts" },
  { from: "modules/memo/memo.test.ts", specifier: "../gitea/gitea.ts" },
];

/** Imports that must stay allowed. */
const GOOD: Import[] = [
  { from: "kernel/service/agent-service.test.ts", specifier: "../../testing/testing.ts" },
  { from: "kernel/service/tools.test.ts", specifier: "../../testing/tools.ts" },
  { from: "kernel/service/agent-service.test.ts", specifier: "@earendil-works/pi-ai" },
  { from: "modules/memo/memo.test.ts", specifier: "../../testing/testing.ts" },
  { from: "modules/memo/index.ts", specifier: "./records/index.ts" },
  { from: "modules/web/http-fetcher.ts", specifier: "linkedom" },
  { from: "kernel/open.ts", specifier: "../platform/records/records.ts" },
  { from: "modules/gitea/module.ts", specifier: "../../kernel/module.ts" },
];

test("each deliberate break of the layers is refused, and the allowed imports pass", () => {
  expect(BAD.filter((imported) => violation(imported) === undefined)).toEqual([]);
  expect(GOOD.map((imported) => violation(imported)).filter((why) => why !== undefined)).toEqual([]);
});

test("a refusal says which rule and why", () => {
  expect(violation({ from: "modules/gitea/gitea.ts", specifier: "../memo/memo.ts" })).toStartWith(
    "modules/gitea/gitea.ts imports ../memo/memo.ts: modules/gitea may use ",
  );
});

// The package serves applications that have their own channels: nothing in it may name one, or the project that wrote it.
// Test data is free to use any key, since a key is only a string to the kernel.
const NAMES = /telegram|feishu|lark|wechat|weixin|durable-bot|durable-claw|durable-feishu|飞书|微信/i;

test("the sources name no channel and no application", () => {
  const strays = files
    .filter((file) => !isTest(file) && !zoneOf(file)?.free)
    .flatMap((file) =>
      readFileSync(`${SRC}${file}`, "utf8")
        .split("\n")
        .flatMap((line, index) => (NAMES.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
    );
  expect(strays).toEqual([]);
});

// Every document of the application says when it is stored whole (kernel/app-docs.ts): one defined straight with
// Durable's defineDoc would keep every change it ever had. Tests may define their own.
test("the kernel defines its documents only through kernel/app-docs.ts", () => {
  const direct = files.filter(
    (file) =>
      file !== "kernel/app-docs.ts" && !isTest(file) && !zoneOf(file)?.free && /\bdefineDoc(Family)?\s*[<(]/.test(readFileSync(`${SRC}${file}`, "utf8")),
  );
  expect(direct).toEqual([]);
});

// Model-facing text lives in the prompt catalogs and Gitea admin text in texts.ts; other Chinese in code is stray copy. Tests are exempt.
const COPY_HOMES = [/^kernel\/prompts\.ts$/, /^modules\/[^/]+\/prompts\.ts$/, /^modules\/gitea\/texts\.ts$/];
const HAN = /\p{Script=Han}/u;

function literalsOf(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(`${SRC}${file}`, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("copy stays in the prompt catalogs and the texts module", () => {
  const strays = files
    .filter((file) => !isTest(file) && !zoneOf(file)?.free && !COPY_HOMES.some((home) => home.test(file)))
    .flatMap((file) =>
      literalsOf(file)
        .filter((text) => HAN.test(text))
        .map((text) => `${file}: ${text}`),
    );
  expect(strays).toEqual([]);
});
