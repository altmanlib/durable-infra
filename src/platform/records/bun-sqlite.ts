import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { SqliteDatabase } from "kysely";

/**
 * Lets Kysely's SQLite dialect drive `bun:sqlite`. The dialect asks for a small interface modelled on better-sqlite3
 * (https://kysely-org.github.io/kysely-apidoc/interfaces/SqliteDatabase.html); `bun:sqlite` differs in two ways: the
 * parameters are spread, not an array, and a statement has no `reader` flag. It does list the columns it returns, which
 * is empty for a statement that returns none (an insert, a `create`), so that tells the two apart.
 */
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
