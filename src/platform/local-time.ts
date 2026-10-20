/**
 * Times as the model and the user see them: local wall-clock time, never a zone name, UTC or an offset
 * (docs/design/2026-10-13-local-time.md). Everything the tools say or accept about time goes through here, so the
 * zone is chosen in one place: `zone` defaults to the service's own and becomes a per-user value later without
 * touching the tools.
 */

/** The zone the service runs in (`TZ`). */
export function serviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `2026-10-13 13:24:26 Tuesday`: the local date, time and weekday of an instant. */
export function formatLocal(instant: Date, zone: string = serviceZone()): string {
  const local = Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(zone);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(instant);
  return `${local.toPlainDate().toString()} ${local.toPlainTime().toString({ smallestUnit: "second" })} ${weekday}`;
}

/** `2026-10-05T18:30[:00[.fff]]`, a space instead of the `T` allowed; a date and a time of day, nothing else. */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;
/** An ISO 8601 date and time that carries its own offset: `...Z` or `...+08:00`. */
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/**
 * The instant (ms) a local date and time stands for, or undefined when it is not one. A date and time with an offset
 * of its own is taken at its word. In a zone that skips an hour, a time inside the gap moves on to the first time
 * that exists; in one that repeats an hour, the first of the two is meant.
 */
export function parseLocal(value: string, zone: string = serviceZone()): number | undefined {
  const text = value.trim();
  if (WITH_OFFSET.test(text)) {
    const ms = Date.parse(text.replace(" ", "T"));
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (!WALL_CLOCK.test(text)) return undefined;
  try {
    return Temporal.PlainDateTime.from(text.replace(" ", "T")).toZonedDateTime(zone, { disambiguation: "compatible" }).epochMilliseconds;
  } catch {
    // A date that does not exist, such as February 30.
    return undefined;
  }
}
