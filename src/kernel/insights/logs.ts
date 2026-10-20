/**
 * Reading the service log files for the console: newest first, an event with its indented
 * continuation lines, filtered, a page at a time. Files are read backwards in chunks from a position, never whole, and
 * one call scans a bounded number of bytes; `next` says where to go on.
 */
import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import type { LogLevel } from "../../platform/log.ts";
import { LOG_FILE_COUNT, logFileName } from "../../platform/log-file.ts";
import { QueryError } from "./insights.ts";

export type LogEntry = {
  /** Milliseconds; null for a line not in the log's format. */
  at: number | null;
  level: LogLevel | null;
  event: string;
  /** Name and value, in the order of the line; quoted values unquoted. */
  fields: [string, string][];
  /** The continuation lines (a stack, its causes), without their indent. */
  detail: string[];
  /** The first line as written. */
  line: string;
};

export type LogQuery = {
  /** The least level shown. */
  level?: LogLevel;
  /** Start of the event name, such as a channel's name and a dot, or `turn.done`. */
  event?: string;
  /** Found anywhere in the event, its stack included; any case. */
  text?: string;
  /** Milliseconds, both ends included. */
  from?: number;
  to?: number;
  limit?: number;
  /** The `next` of the page before. */
  cursor?: string;
};

export type LogPage = {
  entries: LogEntry[];
  /** Where an older page starts; null once the oldest file has been read, or `from` passed. */
  next: string | null;
};

export const LOG_PAGE_DEFAULT = 100;
export const LOG_PAGE_MAX = 500;
export const LOG_TEXT_MAX = 200;
const SCAN_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

const RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const HEAD = /^(\S+) (info|warn|error) (\S+)(?: (.*))?$/;
const FIELD = /([^\s=]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
/**
 * A cursor names a file by its inode and the hash of its first line, then a byte offset in it. The inode alone is not
 * enough: once a rotation deletes a file, the system may give its inode to the next one (Linux does at once), and an old
 * cursor would read the wrong file. A log file only grows and a rotation only renames it, so its first line never
 * changes, and a new file starts with a later one.
 */
const CURSOR = /^(\d+)-([0-9a-f]{8}):(\d+)$/;
const NEWLINE = 0x0a;

function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return String(JSON.parse(value));
  } catch {
    return value;
  }
}

/** One event from its first line and its continuation lines. */
export function parseEntry(line: string, detail: string[] = []): LogEntry {
  const match = HEAD.exec(line);
  const at = match ? Date.parse(match[1] as string) : Number.NaN;
  if (!match || Number.isNaN(at)) return { at: null, level: null, event: "", fields: [], detail, line };
  const fields: [string, string][] = [];
  for (const [, name, value] of (match[4] ?? "").matchAll(FIELD)) fields.push([name as string, unquote(value as string)]);
  return { at, level: match[2] as LogLevel, event: match[3] as string, fields, detail, line };
}

type Open = { handle: FileHandle; id: string; size: number };

/** How much of a file's start is read to find its first line. */
const FIRST_LINE_BYTES = 512;

export class LogReader {
  readonly #dir: string;
  readonly #count: number;
  readonly #scanBytes: number;
  readonly #chunkBytes: number;

  constructor(options: { dir: string; count?: number; scanBytes?: number; chunkBytes?: number }) {
    this.#dir = options.dir;
    this.#count = options.count ?? LOG_FILE_COUNT;
    this.#scanBytes = options.scanBytes ?? SCAN_BYTES;
    this.#chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  }

  async read(query: LogQuery = {}): Promise<LogPage> {
    const limit = query.limit ?? LOG_PAGE_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > LOG_PAGE_MAX) throw new QueryError(`limit must be a whole number from 1 to ${LOG_PAGE_MAX}`);
    if (query.level !== undefined && !(query.level in RANK)) throw new QueryError("level must be info, warn or error");
    if ((query.text?.length ?? 0) > LOG_TEXT_MAX) throw new QueryError(`text must be at most ${LOG_TEXT_MAX} characters`);
    const cursor = query.cursor === undefined ? undefined : CURSOR.exec(query.cursor);
    if (cursor === null) throw new QueryError("cursor is not one this service gave");
    const text = query.text?.toLowerCase();
    const matches = (entry: LogEntry): boolean =>
      (query.level === undefined || (entry.level !== null && RANK[entry.level] >= RANK[query.level])) &&
      (!query.event || entry.event.startsWith(query.event)) &&
      (query.to === undefined || entry.at === null || entry.at <= query.to) &&
      (!text || [entry.line, ...entry.detail].join("\n").toLowerCase().includes(text));

    // Every file is opened before reading, so a rotation meanwhile renames or removes nothing this call reads.
    const files = await this.#open();
    try {
      let first = 0;
      let start = files[0]?.size ?? 0;
      if (cursor) {
        first = files.findIndex((file) => file.id === `${cursor[1]}-${cursor[2]}`);
        // The file the cursor points into is gone: rotated out, and everything older with it.
        if (first === -1) return { entries: [], next: null };
        start = Math.min(Number(cursor[3]), (files[first] as Open).size);
      }

      const entries: LogEntry[] = [];
      let scanned = 0;
      for (let index = first; index < files.length; index++) {
        const file = files[index] as Open;
        // Continuation lines read so far whose first line is further back, newest first.
        let pending: string[] = [];
        let end = index === first ? start : file.size;
        while (end > 0) {
          const { buffer, from } = await this.#chunk(file.handle, end);
          let lineEnd = end;
          for (let at = end - from - 1; at >= -1; at--) {
            if (at !== -1 && buffer[at] !== NEWLINE) continue;
            const lineStart = from + at + 1;
            const raw = buffer.toString("utf8", at + 1, lineEnd - from).replace(/\n$/, "");
            lineEnd = lineStart;
            if (raw === "") continue;
            if (/^\s/.test(raw)) {
              pending.push(raw.trimStart());
              continue;
            }
            const entry = parseEntry(raw, pending.reverse());
            pending = [];
            const here = `${file.id}:${lineStart}`;
            if (query.from !== undefined && entry.at !== null && entry.at < query.from) return { entries, next: null };
            if (matches(entry)) entries.push(entry);
            if (entries.length >= limit) return { entries, next: here };
            if (scanned + (end - lineStart) >= this.#scanBytes) return { entries, next: here };
          }
          scanned += end - from;
          end = from;
        }
      }
      return { entries, next: null };
    } finally {
      await Promise.all(files.map((file) => file.handle.close()));
    }
  }

  /** The files there are, newest first. */
  async #open(): Promise<Open[]> {
    const files: Open[] = [];
    for (let index = 0; index < this.#count; index++) {
      let handle: FileHandle;
      try {
        handle = await open(join(this.#dir, logFileName(index)), "r");
      } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") continue;
        await Promise.all(files.map((file) => file.handle.close()));
        throw error;
      }
      const stat = await handle.stat({ bigint: true });
      const head = Buffer.alloc(FIRST_LINE_BYTES);
      const { bytesRead } = await handle.read(head, 0, FIRST_LINE_BYTES, 0);
      // The first line, or its first FIRST_LINE_BYTES when longer: either way what this file starts with, for good.
      const start = head.subarray(0, bytesRead);
      const newline = start.indexOf(NEWLINE);
      const firstLine = newline === -1 ? start : start.subarray(0, newline);
      const print = createHash("sha256").update(firstLine).digest("hex").slice(0, 8);
      files.push({ handle, id: `${stat.ino}-${print}`, size: Number(stat.size) });
    }
    return files;
  }

  /**
   * The bytes before `end` (a line boundary) that hold whole lines: from the start of the file, or from just after a
   * newline. A line longer than the chunk makes the chunk grow until it fits.
   */
  async #chunk(handle: FileHandle, end: number): Promise<{ buffer: Buffer; from: number }> {
    for (let size = this.#chunkBytes; ; size *= 2) {
      const from = Math.max(0, end - size);
      const buffer = Buffer.alloc(end - from);
      await handle.read(buffer, 0, buffer.length, from);
      if (from === 0) return { buffer, from };
      const newline = buffer.indexOf(NEWLINE);
      if (newline !== -1 && from + newline + 1 < end) return { buffer: buffer.subarray(newline + 1), from: from + newline + 1 };
    }
  }
}
