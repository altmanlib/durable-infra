import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { bunSqlite } from "./bun-sqlite.ts";

test("the adapter hands Kysely what its SQLite dialect asks of a driver: parameters in an array, and which statements return rows", () => {
  const sqlite = new Database(":memory:", { strict: true });
  const driver = bunSqlite(sqlite);
  expect(driver.prepare("create table t (a integer, b text) strict").reader).toBe(false);
  driver.prepare("create table t (a integer, b text) strict").run([]);
  const insert = driver.prepare("insert into t (a, b) values (?, ?)");
  expect(insert.reader).toBe(false);
  expect(insert.run([1, "x"])).toMatchObject({ changes: 1 });
  const select = driver.prepare("select a, b from t where a = ?");
  expect(select.reader).toBe(true);
  expect(select.all([1])).toEqual([{ a: 1, b: "x" }]);
  expect([...select.iterate([1])]).toEqual([{ a: 1, b: "x" }]);
  // A statement that reads and writes both returns rows, so it is a reader.
  expect(driver.prepare("insert into t (a, b) values (?, ?) returning a").reader).toBe(true);
  expect(driver.prepare("pragma journal_mode").reader).toBe(true);
  driver.close();
});
