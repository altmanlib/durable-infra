import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import { log } from "../../platform/log.ts";
import type { EditablePrompts, PromptEffect, PromptEntry } from "../prompts.ts";
import { AccessList } from "./access.ts";
import { ChannelStore } from "./channel-store.ts";
import { AllowlistDoc, type Change, Changes, MAX_CHANGES, PromptEdits, recordChange } from "./docs.ts";
import { SettingsError } from "./error.ts";

const context = BACKGROUND_CONTEXT;

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

/** A page of changes, newest first. */
export type ChangePage = { items: Change[] /** Pass as `before` for the next, older page. */; next?: number };

type State = { edits: Record<string, string>; versions: Record<string, number>; changes: Change[] };

const lockOf = (entry: PromptEntry): PromptLock | undefined => {
  if (!entry.editable) return "guard";
  // Tool descriptions are read when the extension is installed, so an edit would wait for a restart; shown, not edited.
  return entry.effect === "extension-install" ? "restart" : undefined;
};

/**
 * What an operator changes without a deploy, kept in the same storage as everything else (docs/design/2026-10-06-console.md §3.1).
 * Each change and its record in the history are one commit, so neither exists without the other. Writes run one at a
 * time; reads answer from memory.
 *
 * Edits reach whatever reads the `EditablePrompts` it was opened with: the model's requests, and the channels' welcomes.
 */
export class Settings {
  readonly #harness: Harness;
  readonly #storage: Storage;
  readonly #prompts: EditablePrompts;
  readonly #now: () => number;
  readonly #maxChanges: number;
  readonly #channels = new Map<string, ChannelStore>();
  /** Who may use each channel; channels open their list at start, the console reads and changes it. */
  readonly access: AccessList;
  #state: State;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    harness: Harness,
    storage: Storage,
    prompts: EditablePrompts,
    now: () => number,
    maxChanges: number,
    state: State,
    allowlist: Awaited<ReturnType<typeof AccessList.read>>,
  ) {
    this.#harness = harness;
    this.#storage = storage;
    this.#prompts = prompts;
    this.#now = now;
    this.#maxChanges = maxChanges;
    this.#state = state;
    this.access = new AccessList(
      harness,
      {
        now,
        maxChanges,
        serial: (work) => this.#serial(work),
        // The history is shared: a change made by the list shows in `changes()` too.
        refresh: async () => {
          this.#state = await Settings.#read(harness);
        },
      },
      allowlist,
    );
  }

  /** Run `work` after the writes before it, so state read after a commit is never replaced by an older one. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Load the stored settings and apply them; call before any work resumes, so no request renders an older text. */
  static async open(harness: Harness, storage: Storage, options: { prompts: EditablePrompts; now?: () => number; maxChanges?: number }): Promise<Settings> {
    // A watch is not needed: this process is the only writer. The documents are created here so a read finds them.
    await harness.commit(async (tx) => {
      await tx.doc(PromptEdits);
      await tx.doc(AllowlistDoc);
      await tx.doc(Changes);
    }, context);
    const settings = new Settings(
      harness,
      storage,
      options.prompts,
      options.now ?? Date.now,
      options.maxChanges ?? MAX_CHANGES,
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

  /** The documents of a channel, for that channel alone: hand it to the channel when it starts, as its list of users is. */
  channel(name: string): ChannelStore {
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

  /**
   * Replace the text of a prompt. `version` is the one the caller read; a different one means someone changed it since,
   * and nothing is written. Text equal to the default is stored as no edit, so `edited` stays true only for real edits.
   */
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
      let changed = false;
      await this.#harness.commit(async (tx) => {
        const doc = await tx.doc(PromptEdits);
        const current = doc.versions[id] ?? 0;
        // Checked before anything is touched, inside the commit that writes, so a stale caller cannot slip in between.
        if (version !== current) throw new SettingsError("conflict", `${id} was changed since it was read (version ${current}, not ${version}); read it again`);
        const before = doc.edits[id] ?? null;
        if (before === after) return;
        changed = true;
        if (after === null) delete doc.edits[id];
        else doc.edits[id] = after;
        doc.versions[id] = current + 1;
        await recordChange(tx, { at, area: "prompt", target: id, before, after }, this.#maxChanges);
      }, context);
      if (changed) {
        this.#state = await Settings.#read(this.#harness);
        this.#apply();
        log.info("settings.prompt_changed", { id, version: this.#state.versions[id] ?? 0, reset: after === null, chars: after?.length ?? 0 });
      }
      return this.#view(id);
    };
    return this.#serial(run);
  }

  /** Note in the history that an operator did something to a conversation; the action itself is the caller's. */
  recordAction(key: string, action: "reset" | "compact" | "abort"): Promise<void> {
    return this.#serial(async () => {
      const at = this.#now();
      await this.#harness.commit(
        async (tx) => recordChange(tx, { at, area: "conversation", target: key, before: null, after: action }, this.#maxChanges),
        context,
      );
      this.#state = await Settings.#read(this.#harness);
      log.info("settings.conversation_action", { key, action });
    });
  }

  #known(id: string): string {
    if (!this.#prompts.catalog.has(id)) throw new SettingsError("unknown_prompt", `no such prompt: ${id}`);
    return id;
  }

  /** Changes newest first, `limit` at a time (default 50, at most 200); `before` is the `next` of the page before. */
  changes(options: { limit?: number; before?: number } = {}): ChangePage {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const older = this.#state.changes.filter((change) => options.before === undefined || change.seq < options.before);
    const items = older.slice(-limit).reverse();
    const last = items.at(-1);
    const more = last !== undefined && older.length > items.length;
    return { items, ...(more ? { next: last.seq } : {}) };
  }
}
