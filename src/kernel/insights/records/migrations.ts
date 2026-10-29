import { sql } from "kysely";

import { inTransaction, type Migrations } from "../../../platform/records/migrations.ts";

/** The shape of the insights tables, in the order the steps were written (rules at `Migrations`). */
export const INSIGHTS_MIGRATIONS: Migrations = {
  "0001_ledger": {
    up: (db) =>
      inTransaction(db, [
        sql`create table insights_spend (
          key text not null,
          bucket integer not null,
          kind text not null,
          name text not null,
          input integer not null default 0,
          output integer not null default 0,
          cache_read integer not null default 0,
          cache_write integer not null default 0,
          total_tokens integer not null default 0,
          primary key (key, bucket, kind, name)
        ) strict`,
        // A report over all keys reads a range of buckets.
        sql`create index insights_spend_by_bucket on insights_spend (bucket)`,
        sql`create table insights_cursor (
          conversation_id integer primary key,
          key text not null,
          last_entry_id integer not null
        ) strict`,
        // The conversations of a key, for the part of its spend that no entry carries.
        sql`create index insights_cursor_by_key on insights_cursor (key)`,
        sql`create table insights_conversation (
          key text primary key,
          conversation_id integer not null,
          last_active_at integer
        ) strict`,
        // The listing's order; rows without a message sort last.
        sql`create index insights_conversation_by_activity on insights_conversation (last_active_at desc, key asc)`,
      ]),
  },
};
