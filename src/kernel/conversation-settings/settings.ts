import { log } from "../../platform/log.ts";
import type { SettingCatalog } from "./catalog.ts";
import type { SettingStore } from "./records/index.ts";
import { CHECK_TIMEOUT_MS, maxCharsOf, type SettingSpec } from "./spec.ts";

/** A registered setting with what the conversation set it to, if anything. */
export type SettingView = { spec: SettingSpec<unknown>; value?: string; updatedAt?: number };

/** What `set` came to; anything but `saved` wrote nothing. */
export type SettingSetResult =
  | { result: "saved"; value: string; checkMs: number }
  | { result: "unknown_setting" }
  | { result: "invalid_value" | "rejected"; reason: string }
  /** The check threw or took too long, so the value was not checked and not kept. */
  | { result: "check_failed"; ms: number; cause: unknown };

export type SettingClearResult = "cleared" | "missing" | "unknown_setting";

export type ConversationSettingsOptions = { checkTimeoutMs?: number };

/** A check that does not finish in time rejects, whether or not it heeds the signal. */
async function checked<T>(work: (signal: AbortSignal) => T | Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`the check took longer than ${ms} ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The settings of each conversation (docs/design/2026-10-20-group-settings.md §4): what the catalog registers, kept by
 * the store. The tools list, set and clear them; the features that use one read it with `get`. Storage failures throw.
 */
export class ConversationSettings {
  readonly catalog: SettingCatalog;
  readonly #store: SettingStore;
  readonly #timeoutMs: number;

  constructor(catalog: SettingCatalog, store: SettingStore, options: ConversationSettingsOptions = {}) {
    this.catalog = catalog;
    this.#store = store;
    this.#timeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  }

  /**
   * The setting as its reader uses it: `undefined` when the conversation has not set it, when what is stored cannot be
   * decoded (logged), and when the spec is not registered, even if a row of its name is left in the table.
   */
  async get<T>(key: string, spec: SettingSpec<T>): Promise<T | undefined> {
    if (this.catalog.get(spec.name) === undefined) return undefined;
    const stored = await this.#store.read(key, spec.name);
    if (stored === undefined) return undefined;
    const value = spec.decode(stored);
    if (value === undefined) log.warn("setting.undecodable", { key, name: spec.name });
    return value;
  }

  /** Every registered setting, in the catalog's order, with the conversation's value; rows of names not registered are left out. */
  async list(key: string): Promise<SettingView[]> {
    const rows = new Map((await this.#store.list(key)).map((row) => [row.name, row]));
    return this.catalog.all().map((spec) => {
      const row = rows.get(spec.name);
      return row ? { spec, value: row.value, updatedAt: row.updatedAt } : { spec };
    });
  }

  /** Check the value, then keep what the check gives back (docs/design/2026-10-20-group-settings.md §4.1). */
  async set(key: string, name: string, input: string, by: string): Promise<SettingSetResult> {
    const spec = this.catalog.get(name.trim());
    if (spec === undefined) return { result: "unknown_setting" };
    const value = input.trim();
    const max = maxCharsOf(spec);
    if (value.length === 0) return { result: "invalid_value", reason: "The value is empty; to unset the setting, clear it instead." };
    if (value.length > max) return { result: "invalid_value", reason: `The value is at most ${max} characters; this one has ${value.length}.` };
    const started = Date.now();
    let check: Awaited<ReturnType<SettingSpec<unknown>["check"]>>;
    try {
      check = await checked((signal) => spec.check(value, { conversationKey: key, signal }), this.#timeoutMs);
    } catch (cause) {
      return { result: "check_failed", ms: Date.now() - started, cause };
    }
    if (!check.ok) return { result: check.code, reason: check.reason };
    await this.#store.write(key, spec.name, check.value, by);
    return { result: "saved", value: check.value, checkMs: Date.now() - started };
  }

  /** Take the setting away, back to not set; `missing` when it was not set. */
  async clear(key: string, name: string): Promise<SettingClearResult> {
    const spec = this.catalog.get(name.trim());
    if (spec === undefined) return "unknown_setting";
    return this.#store.remove(key, spec.name);
  }
}
