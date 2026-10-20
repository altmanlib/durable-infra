import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { type Kysely, sql } from "kysely";
import { captureLogs, tempDirPerTest } from "../../testing/testing.ts";
import { inTransaction, type Migrations } from "./migrations.ts";
import { Records } from "./records.ts";

const dir = tempDirPerTest("records-");

let open: Records[] = [];
afterEach(async () => {
  for (const records of open) await records.close().catch(() => {});
  open = [];
});

async function openAt(path: string, options: { now?: () => number } = {}): Promise<Records> {
  const records = await Records.open(path, options);
  open.push(records);
  return records;
}

async function close(records: Records): Promise<void> {
  open = open.filter((one) => one !== records);
  await records.close();
}

type Notes = { notes_items: { id: number; text: string } };

const NOTES: Migrations = {
  "0001_items": { up: (db) => inTransaction(db, [sql`create table notes_items (id integer primary key, text text not null) strict`]) },
};

/** Every name in the file but SQLite's own, read straight from it. */
function namesIn(path: string): string[] {
  const raw = new Database(path, { readonly: true });
  const rows = raw.query("select name from sqlite_master where substr(name, 1, 7) <> 'sqlite_' order by name").all() as { name: string }[];
  raw.close();
  return rows.map((row) => row.name);
}

const executed = async <Schema>(db: Kysely<Schema>, domain: string) =>
  (await sql<{ name: string }>`select name from ${sql.table(`${domain}_migration`)} order by name`.execute(db)).rows.map((row) => row.name);

test("a domain's tables are made once, keep what was written across a restart, and opening again runs nothing", async () => {
  const path = `${dir()}/nested/app.sqlite`;
  let records = await openAt(path);
  let notes = await records.tables<Notes>("notes", NOTES);
  await notes.insertInto("notes_items").values({ id: 1, text: "kept" }).execute();
  await close(records);

  records = await openAt(path);
  const ran = await captureLogs(async () => {
    notes = await records.tables<Notes>("notes", NOTES);
  });
  expect(ran.some((entry) => entry.line.includes("records.migrated"))).toBe(false);
  expect(await notes.selectFrom("notes_items").selectAll().execute()).toEqual([{ id: 1, text: "kept" }]);
  expect(await executed(notes, "notes")).toEqual(["0001_items"]);
});

test("two domains number their steps apart and each keeps its own record of them", async () => {
  const path = `${dir()}/app.sqlite`;
  const records = await openAt(path);
  const other: Migrations = {
    "0001_items": { up: (db) => inTransaction(db, [sql`create table other_items (a integer) strict`]) },
    "0002_more": { up: (db) => inTransaction(db, [sql`create table other_more (a integer) strict`]) },
  };
  const notes = await records.tables<Notes>("notes", NOTES);
  const more = await records.tables<{ other_items: { a: number } }>("other", other);
  expect(await executed(notes, "notes")).toEqual(["0001_items"]);
  expect(await executed(more, "other")).toEqual(["0001_items", "0002_more"]);
  expect(namesIn(path)).toEqual(
    expect.arrayContaining(["notes_items", "notes_migration", "notes_migration_lock", "other_items", "other_more", "other_migration", "other_migration_lock"]),
  );
});

test("a step that makes a name without the domain's prefix is refused, so two domains cannot take the same name", async () => {
  const records = await openAt(":memory:");
  const stray: Migrations = {
    "0001_items": {
      up: (db) => inTransaction(db, [sql`create table notes_items (a integer) strict`, sql`create index items_by_a on notes_items (a)`]),
    },
  };
  await expect(records.tables("notes", stray)).rejects.toThrow("items_by_a");
});

test("a step that fails halfway leaves nothing behind, and runs again from the start once it is fixed", async () => {
  const path = `${dir()}/app.sqlite`;
  let records = await openAt(path);
  const broken: Migrations = {
    "0001_items": {
      up: (db) => inTransaction(db, [sql`create table notes_items (a integer) strict`, sql`create table notes_bad as select * from missing_table`]),
    },
  };
  await expect(records.tables("notes", broken)).rejects.toThrow();
  await close(records);
  expect(namesIn(path)).not.toContain("notes_items");

  records = await openAt(path);
  const notes = await records.tables<Notes>("notes", NOTES);
  expect(namesIn(path)).toContain("notes_items");
  expect(await executed(notes, "notes")).toEqual(["0001_items"]);
});

test("a database that is ahead of the code is refused, not written to", async () => {
  const path = `${dir()}/app.sqlite`;
  let records = await openAt(path);
  const newer: Migrations = { ...NOTES, "0099_later": { up: (db) => inTransaction(db, [sql`create table notes_later (a integer) strict`]) } };
  await records.tables("notes", newer);
  await close(records);

  records = await openAt(path);
  await expect(records.tables("notes", NOTES)).rejects.toThrow();
  await close(records);

  // Nothing of the newer shape was touched by the refusal.
  records = await openAt(path);
  expect(await executed(await records.tables("notes", newer), "notes")).toEqual(["0001_items", "0099_later"]);
});

test("a domain is opened once, under a name that can prefix a table", async () => {
  const records = await openAt(":memory:");
  await records.tables("notes", NOTES);
  await expect(records.tables("notes", NOTES)).rejects.toThrow();
  for (const name of ["", "Notes", "no tes", "1notes", "no-tes", "no_tes", "a".repeat(33)]) await expect(records.tables(name, {})).rejects.toThrow(RangeError);
});

test("health: a failing write or read is not ok until one on the same side works again; a broken constraint is the caller's and does not count", async () => {
  let clock = 100;
  const records = await openAt(":memory:", { now: () => clock });
  const notes = await records.tables<Notes>("notes", NOTES);
  const insert = (id: number) => notes.insertInto("notes_items").values({ id, text: "x" }).execute();
  expect(records.health()).toEqual({ ok: true });

  await insert(1);
  await expect(insert(1)).rejects.toThrow();
  expect(records.health()).toEqual({ ok: true });

  // A write that fails; a read that works says nothing of the writes; a write that works again does.
  const lines = await captureLogs(async () => {
    await expect(sql`insert into notes_missing values (1)`.execute(notes)).rejects.toThrow();
    clock = 200;
    await expect(sql`insert into notes_missing values (2)`.execute(notes)).rejects.toThrow();
  });
  expect(records.health()).toEqual({ ok: false, failingSince: 100, error: "SQLITE_ERROR" });
  expect(lines.filter((entry) => entry.line.includes("records.failing"))).toHaveLength(1);
  await notes.selectFrom("notes_items").selectAll().execute();
  expect(records.health()).toMatchObject({ ok: false });
  await insert(2);
  expect(records.health()).toEqual({ ok: true });

  // The same for reads.
  await expect(sql`select * from notes_missing`.execute(notes)).rejects.toThrow();
  expect(records.health()).toMatchObject({ ok: false, failingSince: 200 });
  await insert(3);
  expect(records.health()).toMatchObject({ ok: false });
  await notes.selectFrom("notes_items").selectAll().execute();
  expect(records.health()).toEqual({ ok: true });
});

test("a write that fails inside a transaction stays failing although the rollback works", async () => {
  const records = await openAt(":memory:");
  const notes = await records.tables<Notes>("notes", NOTES);
  await expect(
    notes.transaction().execute(async (trx) => {
      await sql`insert into notes_missing values (1)`.execute(trx);
    }),
  ).rejects.toThrow();
  expect(records.health()).toMatchObject({ ok: false });
});
