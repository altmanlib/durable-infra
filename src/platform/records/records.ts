import { type Kysely, type LogEvent, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { log } from "../log.ts";
import { type BareDb, openDatabase } from "./database.ts";
import type { Migrations } from "./migrations.ts";

/** A domain's name: the prefix of its tables, so a short lower case word. */
const DOMAIN = /^[a-z][a-z0-9]{0,31}$/;

/** Whether the database answers. Not ok since the first of the failures that no success came after. */
export type RecordsHealth = { ok: true } | { ok: false; failingSince: number; error: string };

type Failing = { since: number; error: string };
/** Reads and writes fail and recover apart: a full disk still reads, so a read that works says nothing of the writes. */
type Side = "read" | "write";

export type RecordsOptions = { now?: () => number };

/** Which side a statement is on, or undefined for the ones that say nothing of either (a transaction's begin and rollback). */
function sideOf(event: LogEvent): Side | undefined {
  const { query } = event;
  switch (query.query.kind) {
    case "SelectQueryNode":
      return "read";
    case "InsertQueryNode":
    case "UpdateQueryNode":
    case "DeleteQueryNode":
    case "MergeQueryNode":
      return "write";
    default:
      if (/^\s*(begin|rollback|savepoint|release)\b/i.test(query.sql)) return undefined;
      return /^\s*(select|with|explain|pragma)\b/i.test(query.sql) ? "read" : "write";
  }
}

/** The SQLite result code of an error (`SQLITE_FULL`, …), or its name when it has none. */
function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "unknown";
}

/**
 * The business database (docs/persistence.md §6): records that keep growing and are looked up by field, which do not
 * need to be committed together with Durable's storage. The core holds the file and nothing in it: each domain brings
 * its own tables with `tables(domain, migrations)`, and reads and writes them itself. The database is closed with
 * `close()`, after the channels stopped writing.
 */
export class Records {
  readonly #db: BareDb;
  readonly #now: () => number;
  readonly #domains = new Set<string>();
  readonly #failing = new Map<Side, Failing>();

  private constructor(db: BareDb, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  /** Open the database at `path` (or `:memory:`). Throws when it cannot. */
  static async open(path: string, options: RecordsOptions = {}): Promise<Records> {
    let observe: (event: LogEvent) => void = () => {};
    const records = new Records(await openDatabase(path, (event) => observe(event)), options.now ?? Date.now);
    observe = (event) => records.#observe(event);
    return records;
  }

  /**
   * Bring `domain`'s tables to the shape `migrations` give, and hand back the database typed by them. Each domain keeps
   * its own record of the steps it ran (`<domain>_migration`), so domains number their steps apart; every table and
   * index a step makes must start with `<domain>_`, so two domains cannot take the same name. A database that has steps
   * of the domain this code does not know is ahead of the code, and is refused: the older code would write to a shape it
   * does not understand. A domain is opened once. Throws when a step fails or breaks the naming; the step that failed
   * left nothing behind (`inTransaction`).
   */
  async tables<Schema extends Record<string, object>>(domain: string, migrations: Migrations): Promise<Kysely<Schema>> {
    if (!DOMAIN.test(domain)) throw new RangeError(`a domain must be lower case letters and digits, at most 32 characters: ${domain.slice(0, 40)}`);
    if (this.#domains.has(domain)) throw new Error(`the tables of ${domain} are already open`);
    const before = new Set(await this.#names());
    const { error, results } = await new Migrator({
      db: this.#db,
      provider: { getMigrations: async () => migrations },
      migrationTableName: `${domain}_migration`,
      migrationLockTableName: `${domain}_migration_lock`,
    }).migrateToLatest();
    for (const result of results ?? []) {
      if (result.status === "Success") log.info("records.migrated", { domain, migration: result.migrationName });
    }
    if (error) {
      log.error("records.migrate_failed", { domain }, error);
      throw error;
    }
    const strays = (await this.#names()).filter((name) => !before.has(name) && !name.startsWith(`${domain}_`));
    if (strays.length > 0) throw new Error(`the migrations of ${domain} made names without the ${domain}_ prefix: ${strays.join(", ")}`);
    this.#domains.add(domain);
    return this.#db.withTables<Schema>();
  }

  /** Whether reads and writes work: a failure (other than a broken constraint, which is the caller's) until one succeeds again. */
  health(): RecordsHealth {
    let first: Failing | undefined;
    for (const failing of this.#failing.values()) if (!first || failing.since < first.since) first = failing;
    return first ? { ok: false, failingSince: first.since, error: first.error } : { ok: true };
  }

  async close(): Promise<void> {
    await this.#db.destroy();
  }

  async #names(): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`select name from sqlite_master where substr(name, 1, 7) <> 'sqlite_'`.execute(this.#db);
    return rows.map((row) => row.name);
  }

  #observe(event: LogEvent): void {
    const side = sideOf(event);
    if (!side) return;
    if (event.level === "query") {
      if (this.#failing.delete(side)) log.info("records.recovered", { side });
      return;
    }
    const error = codeOf(event.error);
    if (error.startsWith("SQLITE_CONSTRAINT")) return;
    const failing = this.#failing.get(side);
    if (failing) {
      failing.error = error;
      return;
    }
    this.#failing.set(side, { since: this.#now(), error });
    // Once, when it starts: what failed is in the log of whoever asked, every time.
    log.error("records.failing", { side, error });
  }
}
