import { expect, test } from "bun:test";

import { SettingsError, type SettingsErrorKind } from "./error.ts";

// A channel with a kind of its own, such as "no such group", throws it as a SettingsError so that one handler catches
// both; the kernel's kinds stay the default, so a handler that maps them is checked against the list.
test("a kind of a channel's own is a SettingsError too, and carries its kind", () => {
  const own = new SettingsError("unknown_group", "no such group: 7");
  expect(own).toBeInstanceOf(SettingsError);
  expect(own.kind).toBe("unknown_group");
  const kernel: SettingsError = new SettingsError("conflict", "changed since it was read");
  const kind: SettingsErrorKind = kernel.kind;
  expect(kind).toBe("conflict");
});
