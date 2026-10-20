import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, JsonObject, SessionDocFamilyToken, Storage } from "@earendil-works/pi-durable";
import { appDocFamily, checkpoint } from "../app-docs.ts";
import type { AccessList } from "./access.ts";
import { recordChange } from "./docs.ts";
import { SettingsError } from "./error.ts";

const context = BACKGROUND_CONTEXT;

/** What a channel keeps in one document: a JSON object. */
export type ChannelDoc = JsonObject;

/** A channel or collection name: lower case, digits and dashes, short, so it can be part of a document kind. */
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_KEY_CHARS = 200;
const PAGE = 100;

/** A channel's change to its documents, with the line of history that must stand or fall with it. */
export type ChannelTx = {
  /** The document at `key` in `collection`, created from `seed` when absent. Change it in place; it is stored when the commit succeeds. */
  get<T extends ChannelDoc>(collection: string, key: string, seed: T): Promise<T>;
  /** Remove the document at `key`; a later `get` starts again from its seed. */
  retire(collection: string, key: string): Promise<void>;
  /** Add a line to the console's history of changes, shown with the target `<channel>/<target>`. */
  record(change: { target: string; before: string | null; after: string | null }): Promise<void>;
};

export type ChannelStoreDeps = {
  harness: Harness;
  storage: Storage;
  access: AccessList;
  now: () => number;
  maxChanges: number;
  /** Run after earlier writes; shared with every other write of the settings. */
  serial: <T>(work: () => Promise<T>) => Promise<T>;
};

const checkName = (what: string, name: string): string => {
  if (!NAME.test(name))
    throw new SettingsError("invalid", `${what} must be lower case letters, digits and dashes, at most 32 characters: ${name.slice(0, 40)}`);
  return name;
};

const checkKey = (key: string): string => {
  if (key === "" || key.length > MAX_KEY_CHARS) throw new SettingsError("invalid", `a document key must be 1 to ${MAX_KEY_CHARS} characters`);
  return key;
};

/**
 * The documents of one channel, kept in the same storage as everything else.
 * A channel reaches Durable only through this class, and only its own documents: the kind of every document is built
 * here from the channel and collection names, so one channel cannot name another's. A collection holds documents by
 * key, one document per key. Writes run one at a time with the rest of the settings, and one commit can also add a
 * line to the history, so a change and the line that tells of it are never half done.
 */
export class ChannelStore {
  readonly #channel: string;
  readonly #deps: ChannelStoreDeps;
  readonly #families = new Map<string, SessionDocFamilyToken<ChannelDoc, ChannelDoc>>();

  constructor(channel: string, deps: ChannelStoreDeps) {
    this.#channel = checkName("a channel name", channel);
    this.#deps = deps;
  }

  #family(collection: string): SessionDocFamilyToken<ChannelDoc, ChannelDoc> {
    const kind = `app.channel.${this.#channel}.${checkName("a collection name", collection)}` as const;
    let family = this.#families.get(kind);
    if (!family) {
      // A channel may write a document on every message (a group's settings, the checks in progress), so a full copy
      // every 50 changes keeps what a read replays, and what the storage holds, small.
      family = appDocFamily<ChannelDoc, ChannelDoc>({ kind, version: 1, initial: (seed) => structuredClone(seed), checkpoint: checkpoint.every(50) });
      this.#families.set(kind, family);
    }
    return family;
  }

  /** The document at `key`, or undefined when there is none. A copy; change documents with `commit`. */
  async read<T extends ChannelDoc>(collection: string, key: string): Promise<Readonly<T> | undefined> {
    const doc = await this.#deps.harness.snapshot(this.#family(collection), checkKey(key), context);
    return doc as Readonly<T> | undefined;
  }

  /** Every key of a collection, sorted. */
  async keys(collection: string): Promise<string[]> {
    const kind = `app.channel.${this.#channel}.${checkName("a collection name", collection)}`;
    const keys: string[] = [];
    let cursor: Awaited<ReturnType<Storage["scanDocuments"]>>["next"];
    do {
      const page = await this.#deps.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind }, PAGE, cursor, context);
      for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
      cursor = page.next;
    } while (cursor);
    return keys.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }

  /**
   * Change documents in one commit: they all change, or, when `work` throws, none does and the error is passed on.
   * Commits run one at a time, so what `work` reads is what the commit before it left.
   */
  commit<R>(work: (tx: ChannelTx) => Promise<R>): Promise<R> {
    return this.#deps.serial(async () => {
      const at = this.#deps.now();
      let touchedSettings = false;
      const result = await this.#deps.harness.commit(async (tx) => {
        touchedSettings = false;
        return work({
          get: async <T extends ChannelDoc>(collection: string, key: string, seed: T) =>
            (await tx.doc(this.#family(collection), checkKey(key), seed)) as unknown as T,
          retire: (collection, key) => tx.retireDoc(this.#family(collection), checkKey(key)),
          record: async (change) => {
            touchedSettings = true;
            await recordChange(
              tx,
              { at, area: "channel", target: `${this.#channel}/${change.target}`, before: change.before, after: change.after },
              this.#deps.maxChanges,
            );
          },
        });
      }, context);
      // The history lives in memory too; take in what this commit wrote.
      if (touchedSettings) await this.#deps.access.reload();
      return result;
    });
  }
}
