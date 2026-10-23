/** The service log on disk, rotated by size so its total stays bounded; a failing disk is reported once on stderr and never reaches the caller. */
import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import { formatLine, type LogLevel, setLogSink } from "./log.ts";

export const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_FILE_COUNT = 5;
export const LOG_FILE_RETRY_MS = 60_000;
const MAX_CAUSES = 3;

/** Name of the log file `index` steps old: `app.log` is the current one, `app.1.log` the one before it, and so on. */
export const logFileName = (index: number): string => (index === 0 ? "app.log" : `app.${index}.log`);

export type LogFileOptions = {
  /** The directory of the log files; the application decides where (`LOG_DIR`, a path under its data directory). */
  dir: string;
  /** Size one file may reach before it is rotated. */
  maxBytes?: number;
  /** Files kept: `app.log` and `count - 1` rotated ones. */
  count?: number;
  retryMs?: number;
  now?: () => number;
  /** Where a failure of the file itself is told; never the log, which would loop. */
  report?: (line: string) => void;
};

/** Continuation lines of an event: the stack of its error and of up to three causes, each line indented. */
export function errorDetail(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth <= MAX_CAUSES; depth++) {
    const stack = current.stack ?? `${current.name}: ${current.message}`;
    const [first = "", ...rest] = stack.split("\n");
    lines.push(depth === 0 ? first : `Caused by: ${first}`, ...rest.map((line) => line.trim()));
    current = current.cause;
  }
  return lines.map((line) => `  ${line}\n`).join("");
}

export class LogFile {
  readonly path: string;
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly count: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly report: (line: string) => void;
  private fd: number | undefined;
  private size = 0;
  /** Set while the file is down: when to try again, and how many events were not written meanwhile. */
  private down: { retryAt: number; dropped: number } | undefined;

  constructor(options: LogFileOptions) {
    this.dir = options.dir;
    this.path = join(this.dir, logFileName(0));
    this.maxBytes = options.maxBytes ?? LOG_FILE_MAX_BYTES;
    this.count = options.count ?? LOG_FILE_COUNT;
    this.retryMs = options.retryMs ?? LOG_FILE_RETRY_MS;
    this.now = options.now ?? Date.now;
    this.report = options.report ?? ((line) => console.error(line));
    this.attempt(() => this.open());
  }

  /** Append one event: its line, then the stack of its error as indented lines. */
  write(line: string, error?: unknown): void {
    let text = `${line}\n${error === undefined ? "" : errorDetail(error)}`;
    if (this.down) {
      const { retryAt, dropped } = this.down;
      if (this.now() < retryAt || !this.attempt(() => this.open(), false)) {
        this.drop();
        return;
      }
      text = `${formatLine("warn", "log_file.resumed", { dropped })}\n${text}`;
    }
    if (!this.attempt(() => this.append(text))) this.drop();
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  /** Count an event the file did not take while it is down. */
  private drop(): void {
    if (this.down) this.down.dropped++;
  }

  private open(): void {
    mkdirSync(this.dir, { recursive: true });
    this.fd = openSync(this.path, "a");
    this.size = fstatSync(this.fd).size;
    this.down = undefined;
  }

  private append(text: string): void {
    if (this.fd === undefined) return;
    const bytes = Buffer.from(text);
    if (this.size > 0 && this.size + bytes.length > this.maxBytes) this.rotate();
    writeSync(this.fd, bytes);
    this.size += bytes.length;
  }

  private rotate(): void {
    this.close();
    const name = (index: number) => join(this.dir, logFileName(index));
    rmSync(name(this.count - 1), { force: true });
    for (let index = this.count - 2; index >= 0; index--) {
      try {
        renameSync(name(index), name(index + 1));
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ENOENT") throw error;
      }
    }
    this.open();
  }

  /** Run a file operation; on failure drop the file until the retry time, telling it once when `tell` is set. */
  private attempt(step: () => void, tell = true): boolean {
    try {
      step();
      return true;
    } catch (error) {
      try {
        this.close();
      } catch {
        // The descriptor is already unusable; nothing more to release.
      }
      this.fd = undefined;
      this.down = { retryAt: this.now() + this.retryMs, dropped: this.down?.dropped ?? 0 };
      if (tell) this.report(formatLine("error", "log_file.failed", { dir: this.dir, retryInSec: Math.round(this.retryMs / 1000) }, error));
      return false;
    }
  }
}

/** Sends every log line to the file as well as where it went so far; returns the undo. */
export function logToFile(options: LogFileOptions): () => void {
  const file = new LogFile(options);
  const previous = setLogSink();
  setLogSink((line: string, level: LogLevel, error?: unknown) => {
    previous(line, level, error);
    file.write(line, error);
  });
  return () => {
    setLogSink(previous);
    file.close();
  };
}
