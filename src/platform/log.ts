/** Values a log line can carry; anything else is turned into text by the caller. */
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export type LogLevel = "info" | "warn" | "error";

/** Receives each finished line; `error` is the original error, kept so its stack can be printed. */
export type LogSink = (line: string, level: LogLevel, error?: unknown) => void;

const toConsole: LogSink = (line, level, error) => {
  if (level === "info") console.log(line);
  else if (error === undefined) console.error(line);
  else console.error(line, error);
};

let sink: LogSink = toConsole;

/** Replace where lines go (tests); without an argument, back to the console. Returns the previous sink. */
export function setLogSink(next?: LogSink): LogSink {
  const previous = sink;
  sink = next ?? toConsole;
  return previous;
}

const BARE = /^[^\s"=]+$/;
const text = (value: string | number | boolean | null): string => {
  const raw = String(value);
  return BARE.test(raw) ? raw : JSON.stringify(raw);
};

/** One line per event: `<time> <level> <event> key=value ...`; event names are stable dotted names, and what varies goes into fields. */
export function formatLine(level: LogLevel, event: string, fields: LogFields = {}, error?: unknown, now: Date = new Date()): string {
  const parts = [now.toISOString(), level, event];
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) parts.push(`${name}=${text(value)}`);
  }
  if (error !== undefined) parts.push(`error=${text(error instanceof Error ? error.message : String(error))}`);
  return parts.join(" ");
}

export const log = {
  info: (event: string, fields?: LogFields): void => sink(formatLine("info", event, fields), "info"),
  warn: (event: string, fields?: LogFields, error?: unknown): void => sink(formatLine("warn", event, fields, error), "warn", error),
  error: (event: string, fields?: LogFields, error?: unknown): void => sink(formatLine("error", event, fields, error), "error", error),
};
