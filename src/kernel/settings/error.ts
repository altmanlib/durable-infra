export type SettingsErrorKind =
  /** No such prompt. */
  | "unknown_prompt"
  /** No such channel on the allowlist. */
  | "unknown_channel"
  /** The text may not be changed here: it is an injection guard, or it only takes effect after a restart. */
  | "locked"
  /** The value is not acceptable: an empty or oversized text, a malformed key, or a similar local check. */
  | "invalid"
  /** A user id on an allowlist is not an acceptable id. */
  | "invalid_user_id"
  /** Replacing an allowlist would leave it empty. */
  | "allowlist_empty"
  /** What the caller changed was changed by someone else since it was read. */
  | "conflict";

/**
 * A change the caller must correct or re-read; the message says what. The kinds above are the kernel's; a channel or a
 * feature that has its own, such as "no such group", names it as the type argument and handles it itself.
 */
export class SettingsError<Kind extends string = SettingsErrorKind> extends Error {
  constructor(
    readonly kind: Kind,
    message: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}
