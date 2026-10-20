/**
 * What a setting is, as the module that uses it registers it. The settings
 * know no setting of their own: every one comes from its user, through `core/open.ts`.
 */

/** What a check came to: the normalized text to keep, or why the value may not be set. */
export type SettingCheck =
  | { ok: true; value: string }
  /**
   * `invalid_value`: not in the setting's format; `rejected`: an outside service says no. The reason reaches the model
   * as it is, so it is a fixed text of the spec, never something an outside service answered.
   */
  | { ok: false; code: "invalid_value" | "rejected"; reason: string };

export type SettingCheckContext = {
  conversationKey: string;
  /** Aborted when the check takes too long (`CHECK_TIMEOUT_MS`); pass it to every outside call. */
  signal: AbortSignal;
};

export type SettingSpec<T = string> = {
  /** A persistent identifier, never changed once released: `<module>.<item>`, lower case, such as `gitea.repo`. */
  name: string;
  /** What it is, in one sentence for the model; `list_settings` shows it. */
  summary: string;
  /** The format, with an example, for the model, such as "owner/repo, e.g. team/app". */
  format: string;
  /** The longest stored text; `DEFAULT_SETTING_CHARS` when left out, at most `MAX_SETTING_CHARS`. */
  maxChars?: number;
  /** Check and normalize a value before it is written; may be async. Throws (network, timeout) when it cannot tell. */
  check(input: string, context: SettingCheckContext): SettingCheck | Promise<SettingCheck>;
  /** The stored text as its readers use it; `undefined` when it cannot be read, which counts as not set. */
  decode(stored: string): T | undefined;
  /** What `list_settings` says when the conversation has not set it, such as "not set: issues cannot be filed". */
  unset?: string;
};

/** A setting's name: a module's prefix and the item, each lower case, joined by dots. */
export const SETTING_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const MAX_SETTING_NAME_CHARS = 64;
/** The longest stored text of a setting that does not say. */
export const DEFAULT_SETTING_CHARS = 200;
/** The longest stored text any setting may have. */
export const MAX_SETTING_CHARS = 1000;
/** How long a check may take before the value is not set (`check_failed`). */
export const CHECK_TIMEOUT_MS = 10_000;

/** The longest text the spec allows. */
export const maxCharsOf = (spec: Pick<SettingSpec<unknown>, "maxChars">): number => spec.maxChars ?? DEFAULT_SETTING_CHARS;
