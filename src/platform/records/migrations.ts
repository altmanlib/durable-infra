import type { Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/** A domain's table shape as named steps. A released step is never edited; changes are new steps, since the database holds real records. */
export type Migrations = Readonly<Record<string, Migration>>;

/** Runs a step's statements in one transaction, so a failed step leaves nothing behind (Kysely's SQLite adapter does not). */
export async function inTransaction(db: Kysely<unknown>, statements: readonly ReturnType<typeof sql>[]): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const statement of statements) await statement.execute(trx);
  });
}
