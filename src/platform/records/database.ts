import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Kysely, type Logger, SqliteDialect } from "kysely";
import { log } from "../log.ts";
import { bunSqlite } from "./bun-sqlite.ts";

/** The database before any domain added its tables: a domain gets its own typed view with `withTables`. */
// biome-ignore lint/complexity/noBannedTypes: Kysely's own "no tables yet" schema is the empty object type.
export type BareDb = Kysely<{}>;

/**
 * Open the business database at `path` (or `:memory:`), with no tables of its own: each domain brings its tables with
 * its migrations (`Records.tables`). `observe` sees every statement Kysely runs and how it went. Throws when it cannot be
 * opened; nothing is left open then.
 */
export async function openDatabase(path: string, observe: Logger): Promise<BareDb> {
  if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    // One writer at a time, a reader never waits for it, and a write waits a moment for a lock someone else holds (a
    // person looking at the file with the sqlite3 shell) instead of failing.
    sqlite.run("pragma journal_mode = wal");
    sqlite.run("pragma synchronous = normal");
    sqlite.run("pragma busy_timeout = 5000");
    return new Kysely({ dialect: new SqliteDialect({ database: bunSqlite(sqlite) }), log: observe });
  } catch (error) {
    log.error("records.open_failed", { path }, error);
    sqlite.close();
    throw error;
  }
}
