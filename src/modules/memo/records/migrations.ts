import { sql } from "kysely";
import { inTransaction, type Migrations } from "../../../platform/records/migrations.ts";

/** The shape of the memo's table, in the order the steps were written (rules at `Migrations`). */
export const MEMO_MIGRATIONS: Migrations = {
  "0001_entry": {
    up: (db) =>
      inTransaction(db, [
        // One row per entry; the key is what makes a second write of a name
        // replace the first. A rowid table: a body may be several kilobytes, too large a row for one without.
        sql`create table memo_entry (
          conversation_key text not null,
          name text not null,
          body text not null,
          updated_at integer not null,
          updated_by text not null default '',
          primary key (conversation_key, name)
        ) strict`,
        // Listing a conversation's entries, newest first.
        sql`create index memo_entry_by_key on memo_entry (conversation_key, updated_at)`,
      ]),
  },
};
