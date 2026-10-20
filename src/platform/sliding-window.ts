/** How many events a key may have within a window of time. */
export type SlidingWindowOptions = {
  max: number;
  windowMs: number;
  /** When this many keys are held, the ones whose events all left the window are let go, so a flood of keys cannot grow the memory without bound. Default 1000. */
  maxKeys?: number;
};

const DEFAULT_MAX_KEYS = 1000;

/**
 * Events per key in a sliding window, kept in memory (docs/persistence.md §8): a restart gives every key a fresh window,
 * which is fine for a guard against floods and against guessing. The one place that counts events in a window: the
 * inputs a conversation may start, the failed attempts of an address. Time is given by the caller, so a test can move it.
 */
export class SlidingWindow {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #events = new Map<string, number[]>();

  constructor(options: SlidingWindowOptions) {
    this.#max = options.max;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** How many keys are held (some may have only old events, until the next sweep). */
  get size(): number {
    return this.#events.size;
  }

  /** How many events the key has in the window that ends at `now`. */
  count(key: string, now: number): number {
    return this.#recent(key, now).length;
  }

  /** Whether the key has used up its events. */
  full(key: string, now: number): boolean {
    return this.count(key, now) >= this.#max;
  }

  /** Add an event whether or not there is room; returns how many the key has now. */
  record(key: string, now: number): number {
    if (this.#events.size >= this.#maxKeys) this.#sweep(now);
    const recent = this.#recent(key, now);
    recent.push(now);
    this.#events.set(key, recent);
    return recent.length;
  }

  /** Add an event if the key has room, and say whether it did. */
  tryStart(key: string, now: number): boolean {
    if (this.full(key, now)) return false;
    this.record(key, now);
    return true;
  }

  /** The key's events that are still in the window; the key is forgotten when there are none. */
  #recent(key: string, now: number): number[] {
    const since = now - this.#windowMs;
    const recent = (this.#events.get(key) ?? []).filter((at) => at > since);
    if (recent.length === 0) this.#events.delete(key);
    else this.#events.set(key, recent);
    return recent;
  }

  #sweep(now: number): void {
    for (const key of [...this.#events.keys()]) this.#recent(key, now);
  }
}
