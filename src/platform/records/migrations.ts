import type { Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The shape of a domain's tables, as steps by name. A step that has been released is never edited: a change to the shape
 * is a new step with the next number, because this database holds real records. Names carry a
 * zero-padded number (`0001_…`) and sort by it, which is how Kysely orders them and how it notices a database that is
 * ahead of the code. A step is plain SQL, not the query builder, so it keeps meaning what it meant when it was written.
 */
export type Migrations = Readonly<Record<string, Migration>>;

/**
 * Run a step's statements as one transaction. Kysely's SQLite adapter does not put a step in a transaction, but SQLite
 * can undo `create table`, so a step that fails halfway leaves nothing behind and runs again from the start next time.
 */
export async function inTransaction(db: Kysely<unknown>, statements: readonly ReturnType<typeof sql>[]): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const statement of statements) await statement.execute(trx);
  });
}
