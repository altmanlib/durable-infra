const DEFAULT_MAX_KEYS = 1000;

/**
 * Lets something happen at most once in an interval for each key, in memory: a warning in the
 * log that a flood of the same trouble would repeat for every message. The first time is always allowed. Time is given
 * by the caller, so a test can move it.
 */
export class Throttle {
  readonly #intervalMs: number;
  readonly #maxKeys: number;
  readonly #last = new Map<string | number, number>();

  constructor(intervalMs: number, options: { maxKeys?: number } = {}) {
    this.#intervalMs = intervalMs;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** How many keys are held (some may be past their interval, until the next sweep). */
  get size(): number {
    return this.#last.size;
  }

  /** Whether the key may act at `now`; when it may, that is noted and the interval starts over. */
  allow(now: number, key: string | number = ""): boolean {
    const last = this.#last.get(key);
    if (last !== undefined && now - last < this.#intervalMs) return false;
    if (this.#last.size >= this.#maxKeys) this.#sweep(now);
    this.#last.set(key, now);
    return true;
  }

  /** Let go of the keys whose interval is over, so a flood of keys cannot grow the memory without bound. */
  #sweep(now: number): void {
    for (const [key, at] of this.#last) if (now - at >= this.#intervalMs) this.#last.delete(key);
  }
}
