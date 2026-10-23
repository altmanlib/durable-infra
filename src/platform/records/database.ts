import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { Kysely, type Logger, SqliteDialect } from "kysely";

import { log } from "../log.ts";
import { bunSqlite } from "./bun-sqlite.ts";

/** The database before any domain adds its tables. */
// biome-ignore lint/complexity/noBannedTypes: Kysely's own "no tables yet" schema is the empty object type.
export type BareDb = Kysely<{}>;

/** Opens the business database at `path` (or `:memory:`) with no tables of its own; `observe` sees every statement. */
export async function openDatabase(path: string, observe: Logger): Promise<BareDb> {
  if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    // WAL lets readers run alongside the writer; a busy timeout covers other tools holding a lock.
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
