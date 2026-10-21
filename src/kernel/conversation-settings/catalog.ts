import { MAX_SETTING_CHARS, MAX_SETTING_NAME_CHARS, SETTING_NAME, type SettingSpec } from "./spec.ts";

/** Every setting, registered once when the core opens; a bad name or limit is a code mistake that fails the start. */
export class SettingCatalog {
  readonly #specs: readonly SettingSpec<unknown>[];
  readonly #byName: ReadonlyMap<string, SettingSpec<unknown>>;

  constructor(specs: readonly SettingSpec<unknown>[]) {
    const byName = new Map<string, SettingSpec<unknown>>();
    for (const spec of specs) {
      if (spec.name.length > MAX_SETTING_NAME_CHARS || !SETTING_NAME.test(spec.name))
        throw new RangeError(`a setting's name is <module>.<item> in lower case, at most ${MAX_SETTING_NAME_CHARS} characters: ${spec.name.slice(0, 80)}`);
      if (byName.has(spec.name)) throw new RangeError(`the setting ${spec.name} is registered twice`);
      if (spec.maxChars !== undefined && !(Number.isInteger(spec.maxChars) && spec.maxChars >= 1 && spec.maxChars <= MAX_SETTING_CHARS))
        throw new RangeError(`the setting ${spec.name} may hold 1 to ${MAX_SETTING_CHARS} characters, not ${spec.maxChars}`);
      byName.set(spec.name, spec);
    }
    this.#specs = [...specs];
    this.#byName = byName;
  }

  /** The setting of that name, or `undefined` when there is none. */
  get(name: string): SettingSpec<unknown> | undefined {
    return this.#byName.get(name);
  }

  /** Every setting, in the order they were registered. */
  all(): readonly SettingSpec<unknown>[] {
    return this.#specs;
  }

  /** Whether there is no setting at all: then the settings tools are not installed. */
  get empty(): boolean {
    return this.#specs.length === 0;
  }
}
