/** Rejects with `onTimeout()` once `signal` aborts while waiting. */
function abortable(signal: AbortSignal, onAbort: () => Error): { promise: Promise<never>; dispose: () => void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(onAbort());
    listener = () => reject(onAbort());
    signal.addEventListener("abort", listener, { once: true });
  });
  promise.catch(() => {});
  return { promise, dispose: () => listener && signal.removeEventListener("abort", listener) };
}

/** At most `limit` holders at a time; the rest wait in arrival order, giving up when their signal aborts. */
export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Returns the release function. */
  async acquire(signal: AbortSignal, onAbort: () => Error): Promise<() => void> {
    if (this.#active >= this.#limit) {
      let grant: (() => void) | undefined;
      const turn = new Promise<void>((resolve) => {
        grant = resolve;
        this.#waiting.push(resolve);
      });
      const gone = abortable(signal, onAbort);
      try {
        await Promise.race([turn, gone.promise]);
      } catch (error) {
        const index = this.#waiting.indexOf(grant as () => void);
        if (index >= 0) this.#waiting.splice(index, 1);
        throw error;
      } finally {
        gone.dispose();
      }
    } else {
      this.#active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    };
  }
}

const DEFAULT_MAX_HOSTS = 1000;

/** Keeps the starts of requests to one host at least `intervalMs` apart. */
export class HostGate {
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #maxHosts: number;
  readonly #next = new Map<string, number>();

  constructor(intervalMs: number, now: () => number = Date.now, options: { maxHosts?: number } = {}) {
    this.#intervalMs = intervalMs;
    this.#now = now;
    this.#maxHosts = options.maxHosts ?? DEFAULT_MAX_HOSTS;
  }

  /** How many hosts are held (some may be past their slot, until the next sweep). */
  get size(): number {
    return this.#next.size;
  }

  /** Wait for this host's turn; the slot is claimed first, so concurrent callers queue one interval apart. */
  async wait(host: string, signal: AbortSignal, onAbort: () => Error): Promise<void> {
    const now = this.#now();
    const start = Math.max(now, this.#next.get(host) ?? 0);
    // A host whose slot has passed waits no longer than an unknown one, so forgetting it changes nothing.
    if (this.#next.size >= this.#maxHosts) for (const [known, at] of this.#next) if (at <= now) this.#next.delete(known);
    this.#next.set(host, start + this.#intervalMs);
    const delay = start - now;
    if (delay <= 0) return;
    const gone = abortable(signal, onAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, delay))), gone.promise]);
    } finally {
      clearTimeout(timer);
      gone.dispose();
    }
  }
}
