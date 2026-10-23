import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Storage } from "@earendil-works/pi-durable";

import { log } from "../../platform/log.ts";
import type { EditablePrompts, PromptEffect, PromptEntry } from "../prompts.ts";
import { AccessList } from "./access.ts";
import type { Change, ChangeLog, ChangePage } from "./change-log.ts";
import { ChannelStore } from "./channel-store.ts";
import { AllowlistDoc, Changes, MAX_CHANGES, PromptEdits, recordChange } from "./docs.ts";
import { SettingsError } from "./error.ts";

const context = BACKGROUND_CONTEXT;

/** The areas the kernel writes itself; an application's own must differ. */
const KERNEL_AREAS: ReadonlySet<string> = new Set(["prompt", "allowlist", "conversation", "channel", "model", "conversation-model"]);

export { type ChannelDoc, ChannelStore, type ChannelTx } from "./channel-store.ts";
export { SettingsError, type SettingsErrorKind } from "./error.ts";

/** Longest text a prompt may be given; a mistake such as a pasted file is refused rather than sent to the model. */
export const MAX_PROMPT_CHARS = 20_000;

/** Why a prompt cannot be edited in the console. */
export type PromptLock = "guard" | "restart";

/** A prompt as the console shows it. */
export type PromptView = {
  id: string;
  /** The text in force: the edit, or the default. */
  text: string;
  /** The built-in text. */
  defaultText: string;
  /** Whether `text` is an edit. */
  edited: boolean;
  /** Where it is used. */
  usage: string;
  effect: PromptEffect;
  /** Set when the console may not change it: `guard` is an injection guard, `restart` only takes effect after a restart. */
  locked?: PromptLock;
  /** Send this back with a change; a change made since makes it stale. */
  version: number;
};

export type { Change, ChangeLog, ChangePage } from "./change-log.ts";

type State = { edits: Record<string, string>; versions: Record<string, number>; changes: Change[] };

const lockOf = (entry: PromptEntry): PromptLock | undefined => {
  if (!entry.editable) return "guard";
  // Read at extension install, so the console shows it but does not edit it.
  return entry.effect === "extension-install" ? "restart" : undefined;
};

/** Operator-changed settings, stored with everything else; writes run one at a time, reads come from memory. Edits reach every reader of `EditablePrompts`. */
export class Settings {
  readonly #harness: Harness;
  readonly #storage: Storage;
  readonly #prompts: EditablePrompts;
  readonly #now: () => number;
  readonly #maxChanges: number;
  readonly #external: ChangeLog | undefined;
  readonly #channels = new Map<string, ChannelStore>();
  readonly #access: AccessList;
  #state: State;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    harness: Harness,
    storage: Storage,
    prompts: EditablePrompts,
    now: () => number,
    maxChanges: number,
    external: ChangeLog | undefined,
    state: State,
    allowlist: Awaited<ReturnType<typeof AccessList.read>>,
  ) {
    this.#harness = harness;
    this.#storage = storage;
    this.#prompts = prompts;
    this.#now = now;
    this.#maxChanges = maxChanges;
    this.#external = external;
    this.#state = state;
    this.#access = new AccessList(
      harness,
      {
        now,
        maxChanges,
        serial: (work) => this.#serial(work),
        // Shared history: list changes also show in `changes()`.
        refresh: async () => {
          this.#state = await Settings.#read(harness);
        },
      },
      allowlist,
    );
  }

  /** Each channel's user list; not available with a custom `ChangeLog`. */
  get access(): AccessList {
    if (this.#external) throw new Error("the allowlist is not available when the application keeps the history of changes itself");
    return this.#access;
  }

  /** Run `work` after the writes before it, so state read after a commit is never replaced by an older one. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Load and apply stored settings; call before work resumes. */
  static async open(
    harness: Harness,
    storage: Storage,
    options: { prompts: EditablePrompts; now?: () => number; maxChanges?: number; changes?: ChangeLog },
  ): Promise<Settings> {
    // This process is the only writer, so no watch is needed; create the documents now so reads find them.
    await harness.commit(async (tx) => {
      await tx.doc(PromptEdits);
      if (options.changes) return;
      await tx.doc(AllowlistDoc);
      await tx.doc(Changes);
    }, context);
    const settings = new Settings(
      harness,
      storage,
      options.prompts,
      options.now ?? Date.now,
      options.maxChanges ?? MAX_CHANGES,
      options.changes,
      await Settings.#read(harness),
      await AccessList.read(harness),
    );
    settings.#apply();
    return settings;
  }

  static async #read(harness: Harness): Promise<State> {
    const edits = await harness.snapshot(PromptEdits, context);
    const changes = await harness.snapshot(Changes, context);
    return { edits: { ...edits?.edits }, versions: { ...edits?.versions }, changes: (changes?.items ?? []).map((item) => ({ ...item })) };
  }

  #apply(): void {
    // Edits of ids the catalog no longer has are kept in the document, not used.
    this.#prompts.setEdits(this.#state.edits);
  }

  /** A channel's own documents, handed to that channel alone. */
  channel(name: string): ChannelStore {
    // Channel history lives in its own commits, so it cannot use a custom log.
    if (this.#external) throw new Error("a channel's documents are not available when the application keeps the history of changes itself");
    let store = this.#channels.get(name);
    if (!store) {
      store = new ChannelStore(name, {
        harness: this.#harness,
        storage: this.#storage,
        access: this.access,
        now: this.#now,
        maxChanges: this.#maxChanges,
        serial: (work) => this.#serial(work),
      });
      this.#channels.set(name, store);
    }
    return store;
  }

  /** Every prompt of the catalog, in catalog order. */
  listPrompts(): PromptView[] {
    return this.#prompts.catalog.ids().map((id) => this.#view(id));
  }

  #view(id: string): PromptView {
    const entry = this.#prompts.catalog.entry(id);
    const edit = this.#state.edits[id];
    const lock = lockOf(entry);
    return {
      id,
      text: edit ?? entry.text,
      defaultText: entry.text,
      edited: edit !== undefined,
      usage: entry.usage,
      effect: entry.effect,
      ...(lock ? { locked: lock } : {}),
      version: this.#state.versions[id] ?? 0,
    };
  }

  /** Replace a prompt's text; `version` must match the stored one or nothing is written. Default text is stored as no edit. */
  setPrompt(id: string, text: string, version: number): Promise<PromptView> {
    return this.#write(id, version, () => {
      if (text.trim() === "") throw new SettingsError("invalid", "the text must not be empty; reset the prompt to go back to the default");
      if (text.length > MAX_PROMPT_CHARS) throw new SettingsError("invalid", `the text must be at most ${MAX_PROMPT_CHARS} characters`);
      return text;
    });
  }

  /** Go back to the built-in text. */
  resetPrompt(id: string, version: number): Promise<PromptView> {
    return this.#write(id, version, () => null);
  }

  #write(rawId: string, version: number, next: () => string | null): Promise<PromptView> {
    const run = async (): Promise<PromptView> => {
      const id = this.#known(rawId);
      const entry = this.#prompts.catalog.entry(id);
      const lock = lockOf(entry);
      if (lock === "guard") throw new SettingsError("locked", `${id} guards against prompt injection and cannot be changed`);
      if (lock === "restart") throw new SettingsError("locked", `${id} is read when the service starts, so it cannot be changed here yet`);
      const wanted = next();
      // The default text is the same as no edit.
      const after = wanted === entry.text ? null : wanted;
      const at = this.#now();
      let change = undefined as Omit<Change, "seq"> | undefined;
      await this.#harness.commit(async (tx) => {
        const doc = await tx.doc(PromptEdits);
        const current = doc.versions[id] ?? 0;
        // Checked inside the write's commit, so a stale caller cannot slip in.
        if (version !== current) throw new SettingsError("conflict", `${id} was changed since it was read (version ${current}, not ${version}); read it again`);
        const before = doc.edits[id] ?? null;
        if (before === after) return;
        if (after === null) delete doc.edits[id];
        else doc.edits[id] = after;
        doc.versions[id] = current + 1;
        change = { at, area: "prompt", target: id, before, after };
        if (!this.#external) await recordChange(tx, change, this.#maxChanges);
      }, context);
      if (change) {
        this.#state = await Settings.#read(this.#harness);
        this.#apply();
        await this.#note(change);
        log.info("settings.prompt_changed", { id, version: this.#state.versions[id] ?? 0, reset: after === null, chars: after?.length ?? 0 });
      }
      return this.#view(id);
    };
    return this.#serial(run);
  }

  /** Note in the history that an operator did something to a conversation; the action itself is the caller's. */
  recordAction(key: string, action: "reset" | "compact" | "abort"): Promise<void> {
    return this.#serial(async () => {
      await this.#append({ at: this.#now(), area: "conversation", target: key, before: null, after: action });
      log.info("settings.conversation_action", { key, action });
    });
  }

  /** Note a conversation's model change in the history; the caller does the move. */
  recordModelChange(key: string, before: string | null, after: string): Promise<void> {
    return this.#serial(async () => {
      await this.#append({ at: this.#now(), area: "conversation-model", target: key, before, after });
      log.info("settings.conversation_model", { key, after });
    });
  }

  /** Note an application's own change in the history; `area` must not be one of the kernel's areas. */
  record(change: { area: string; target: string; before: string | null; after: string | null }): Promise<void> {
    if (change.area === "" || KERNEL_AREAS.has(change.area))
      throw new SettingsError("invalid", `an application's area must not be empty or one of the kernel's: ${change.area}`);
    if (change.target === "") throw new SettingsError("invalid", "a change target must not be empty");
    return this.#serial(async () => {
      await this.#append({ at: this.#now(), ...change });
      log.info("settings.change_recorded", { area: change.area, target: change.target });
    });
  }

  /** Note a channel's change in the history, shown as `<channel>/<target>`; call after the channel's store write. */
  recordChannelChange(channel: string, change: { target: string; before: string | null; after: string | null }): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel))
      throw new SettingsError("invalid", `a channel name must be lower case letters, digits and dashes, at most 32 characters: ${channel.slice(0, 40)}`);
    if (change.target === "") throw new SettingsError("invalid", "a channel change target must not be empty");
    return this.#serial(async () => {
      await this.#append({ at: this.#now(), area: "channel", target: `${channel}/${change.target}`, before: change.before, after: change.after });
      log.info("settings.channel_changed", { channel, target: change.target });
    });
  }

  /** Add a change that has no commit of its own: in the document of the history, or in the application's log. */
  async #append(change: Omit<Change, "seq">): Promise<void> {
    if (this.#external) return this.#note(change);
    await this.#harness.commit(async (tx) => recordChange(tx, change, this.#maxChanges), context);
    this.#state = await Settings.#read(this.#harness);
  }

  /** Note a change in the application's log, after the commit that made it; a failure is logged and the change stands. */
  async #note(change: Omit<Change, "seq">): Promise<void> {
    if (!this.#external) return;
    try {
      await this.#external.record(change);
    } catch (error) {
      log.error("changes.record_failed", { area: change.area, target: change.target }, error);
    }
  }

  #known(id: string): string {
    if (!this.#prompts.catalog.has(id)) throw new SettingsError("unknown_prompt", `no such prompt: ${id}`);
    return id;
  }

  /** Changes newest first, `limit` at a time (default 50, at most 200); `before` is the `next` of the page before. */
  async changes(options: { limit?: number; before?: number } = {}): Promise<ChangePage> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    if (this.#external) return this.#external.page({ limit, ...(options.before !== undefined ? { before: options.before } : {}) });
    const older = this.#state.changes.filter((change) => options.before === undefined || change.seq < options.before);
    const items = older.slice(-limit).reverse();
    const last = items.at(-1);
    const more = last !== undefined && older.length > items.length;
    return { items, ...(more ? { next: last.seq } : {}) };
  }
}
