import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { SqliteDatabase } from "kysely";

/** Adapts `bun:sqlite` to Kysely's better-sqlite3-style dialect: parameters are spread, and an empty column list marks a statement that returns nothing. */
export function bunSqlite(database: Database): SqliteDatabase {
  return {
    close: () => database.close(),
    prepare: (sql) => {
      // `query` keeps the compiled statement, so the same text the next time costs no compiling. The query builder writes
      // a fixed text for a fixed shape of query, so what is kept stays small.
      const statement = database.query(sql);
      return {
        reader: statement.columnNames.length > 0,
        all: (parameters) => statement.all(...(parameters as SQLQueryBindings[])),
        run: (parameters) => statement.run(...(parameters as SQLQueryBindings[])),
        iterate: (parameters) => statement.iterate(...(parameters as SQLQueryBindings[])) as IterableIterator<unknown>,
      };
    },
  };
}
