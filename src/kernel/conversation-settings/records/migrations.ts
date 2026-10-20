import { sql } from "kysely";
import { inTransaction, type Migrations } from "../../../platform/records/migrations.ts";

/** The shape of the conversation settings' table, in the order the steps were written (rules at `Migrations`). */
export const SETTING_MIGRATIONS: Migrations = {
  "0001_setting": {
    up: (db) =>
      inTransaction(db, [
        // One row per setting a conversation has (docs/design/2026-10-20-group-settings.md §3.2): no row is "not set".
        // Rows are short, so the key is the table (without rowid), and listing a conversation's settings walks it.
        sql`create table conversation_setting (
          conversation_key text not null,
          name text not null,
          value text not null,
          updated_at integer not null,
          updated_by text not null default '',
          primary key (conversation_key, name)
        ) strict, without rowid`,
      ]),
  },
};
