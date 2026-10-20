import type { SlidingWindowOptions } from "../../platform/sliding-window.ts";

/** Inputs one conversation may start within a window of time. */
export type RateLimit = Pick<SlidingWindowOptions, "max" | "windowMs">;

/** Generous for one person talking, so it only bites on floods: 30 inputs in 5 minutes. */
export const DEFAULT_RATE_LIMIT: RateLimit = { max: 30, windowMs: 5 * 60_000 };
