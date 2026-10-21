import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { log } from "../../platform/log.ts";
import { AllowlistDoc, recordChange } from "./docs.ts";
import { SettingsError } from "./error.ts";

const context = BACKGROUND_CONTEXT;

/** Most people remembered as turned away; the oldest are forgotten first. */
export const MAX_DENIED = 50;

/** A user ID: letters, digits and a few separators, up to 64 characters. */
const USER_ID = /^[A-Za-z0-9_.:@-]{1,64}$/;

/** What a channel does with the list: ask it for every message, and tell it who it turned away. */
export type ChannelAccess = {
  allows(userId: string | number): boolean;
  /** Remember that this user tried and was refused, so the console can offer to let them in. In memory only. */
  denied(userId: string | number): void;
};

export type ChannelList = { channel: string; userIds: string[]; version: number };

/** Someone a channel turned away. */
export type DeniedUser = { channel: string; userId: string; count: number; lastAt: number };

export type AllowlistView = { channels: ChannelList[]; denied: DeniedUser[] };

type Stored = { channels: Record<string, string[]>; versions: Record<string, number> };

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

/** Who may use each channel, stored so the console can change it without a restart; the stored list rules once a channel has started. */
export class AccessList {
  readonly #harness: Harness;
  readonly #now: () => number;
  readonly #maxChanges: number;
  readonly #serial: <T>(work: () => Promise<T>) => Promise<T>;
  readonly #refresh: () => Promise<void>;
  readonly #lists = new Map<string, Set<string>>();
  readonly #opened = new Set<string>();
  readonly #refused = new Map<string, DeniedUser>();
  #stored: Stored;

  constructor(
    harness: Harness,
    options: { now: () => number; maxChanges: number; serial: <T>(work: () => Promise<T>) => Promise<T>; refresh: () => Promise<void> },
    stored: Stored,
  ) {
    this.#harness = harness;
    this.#now = options.now;
    this.#maxChanges = options.maxChanges;
    this.#serial = options.serial;
    this.#refresh = options.refresh;
    this.#stored = stored;
    this.#adopt();
  }

  static async read(harness: Harness): Promise<Stored> {
    const doc = await harness.snapshot(AllowlistDoc, context);
    return { channels: Object.fromEntries(Object.entries(doc?.channels ?? {}).map(([name, ids]) => [name, [...ids]])), versions: { ...doc?.versions } };
  }

  #adopt(): void {
    this.#lists.clear();
    for (const [channel, ids] of Object.entries(this.#stored.channels)) this.#lists.set(channel, new Set(ids));
  }

  /** Start serving a channel; `configured` seeds the list only when nothing is stored yet, and may not be empty. */
  open(channel: string, configured: readonly (string | number)[]): Promise<ChannelAccess> {
    return this.#serial(async () => {
      const seed = sorted(configured.map(String));
      if (seed.length === 0 || seed.some((id) => !USER_ID.test(id)))
        throw new Error(`the configured users of ${channel} must be a non-empty list of valid user IDs`);
      const stored = this.#stored.channels[channel];
      if (stored === undefined) {
        const at = this.#now();
        await this.#harness.commit(async (tx) => {
          const doc = await tx.doc(AllowlistDoc);
          doc.channels[channel] = seed;
          doc.versions[channel] = (doc.versions[channel] ?? 0) + 1;
          await recordChange(tx, { at, area: "allowlist", target: channel, before: null, after: seed.join(",") }, this.#maxChanges);
        }, context);
        this.#stored = await AccessList.read(this.#harness);
        this.#adopt();
        await this.#refresh();
        log.info("access.seeded", { channel, users: seed.length });
      } else if (seed.join(",") !== sorted(stored).join(",")) {
        // The stored list wins; warn so an edited env var is not silently ignored.
        log.warn("access.env_ignored", { channel, configured: seed.length, stored: stored.length });
      }
      this.#opened.add(channel);
      return {
        allows: (userId) => this.#lists.get(channel)?.has(String(userId)) ?? false,
        denied: (userId) => this.#remember(channel, String(userId)),
      };
    });
  }

  #remember(channel: string, userId: string): void {
    if (this.#lists.get(channel)?.has(userId)) return;
    const key = `${channel}\u0000${userId}`;
    const known = this.#refused.get(key);
    const at = this.#now();
    this.#refused.set(key, { channel, userId, count: (known?.count ?? 0) + 1, lastAt: at });
    if (this.#refused.size > MAX_DENIED) {
      const oldest = [...this.#refused.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
      if (oldest) this.#refused.delete(oldest[0]);
    }
  }

  /** Take in what the storage holds now, after a commit that changed the history outside this class. */
  async reload(): Promise<void> {
    this.#stored = await AccessList.read(this.#harness);
    this.#adopt();
    await this.#refresh();
  }

  /** The list of every channel that has started, and who was turned away (newest first), minus those let in since. */
  list(): AllowlistView {
    const channels = [...this.#opened]
      .sort()
      .map((channel) => ({ channel, userIds: sorted(this.#lists.get(channel) ?? []), version: this.#stored.versions[channel] ?? 0 }));
    const denied = [...this.#refused.values()].filter((user) => !this.#lists.get(user.channel)?.has(user.userId)).sort((a, b) => b.lastAt - a.lastAt);
    return { channels, denied: denied.map((user) => ({ ...user })) };
  }

  /** Replace the list of a channel. `version` is the one the caller read; a different one means it changed since. */
  set(channel: string, userIds: readonly string[], version: number): Promise<ChannelList> {
    return this.#serial(async () => {
      if (!this.#opened.has(channel)) throw new SettingsError("unknown_channel", `no such channel: ${channel}`);
      const ids = sorted(userIds.map((id) => id.trim()));
      if (ids.length === 0) throw new SettingsError("allowlist_empty", "the list must keep at least one user, or nobody could talk to the bot");
      const bad = ids.find((id) => !USER_ID.test(id));
      if (bad !== undefined) throw new SettingsError("invalid_user_id", `not a valid user ID: ${bad.slice(0, 40)}`);
      const at = this.#now();
      let changed = false;
      await this.#harness.commit(async (tx) => {
        const doc = await tx.doc(AllowlistDoc);
        const current = doc.versions[channel] ?? 0;
        if (version !== current)
          throw new SettingsError("conflict", `the list of ${channel} was changed since it was read (version ${current}, not ${version}); read it again`);
        const before = sorted(doc.channels[channel] ?? []);
        if (before.join(",") === ids.join(",")) return;
        changed = true;
        doc.channels[channel] = ids;
        doc.versions[channel] = current + 1;
        await recordChange(tx, { at, area: "allowlist", target: channel, before: before.join(","), after: ids.join(",") }, this.#maxChanges);
      }, context);
      if (changed) {
        this.#stored = await AccessList.read(this.#harness);
        this.#adopt();
        await this.#refresh();
        log.info("settings.allowlist_changed", { channel, users: ids.length, version: this.#stored.versions[channel] ?? 0 });
      }
      return this.list().channels.find((entry) => entry.channel === channel) as ChannelList;
    });
  }
}
