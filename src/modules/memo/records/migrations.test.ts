import { afterEach, expect, test } from "bun:test";
import { sql } from "kysely";
import { Records } from "../../../platform/records/records.ts";
import { tempDirPerTest } from "../../../testing/testing.ts";
import { MEMO_DOMAIN } from "./index.ts";
import { MEMO_MIGRATIONS } from "./migrations.ts";
import type { MemoSchema } from "./schema.ts";

const dir = tempDirPerTest("memo-migrations-");
let records: Records | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
});

test("the migration makes the entry table with its index, and records that it ran", async () => {
  records = await Records.open(":memory:");
  const db = await records.tables<MemoSchema>(MEMO_DOMAIN, MEMO_MIGRATIONS);
  const names = (await sql<{ name: string }>`select name from sqlite_master where name like 'memo_%' order by name`.execute(db)).rows.map((row) => row.name);
  expect(names).toEqual(expect.arrayContaining(["memo_entry", "memo_entry_by_key", "memo_migration"]));
  const ran = (await sql<{ name: string }>`select name from memo_migration`.execute(db)).rows.map((row) => row.name);
  expect(ran).toEqual(["0001_entry"]);
});

test("a row written without updated_by gets the empty default", async () => {
  records = await Records.open(":memory:");
  const db = await records.tables<MemoSchema>(MEMO_DOMAIN, MEMO_MIGRATIONS);
  await sql`insert into memo_entry (conversation_key, name, body, updated_at) values ('k', 'n', 'b', 1)`.execute(db);
  const row = await db.selectFrom("memo_entry").select("updated_by").executeTakeFirstOrThrow();
  expect(row.updated_by).toBe("");
});

test("a second open of the same file runs nothing again and keeps the rows", async () => {
  const path = `${dir()}/app.sqlite`;
  records = await Records.open(path);
  const first = await records.tables<MemoSchema>(MEMO_DOMAIN, MEMO_MIGRATIONS);
  await first.insertInto("memo_entry").values({ conversation_key: "k", name: "n", body: "b", updated_at: 1, updated_by: "" }).execute();
  await records.close();
  records = await Records.open(path);
  const second = await records.tables<MemoSchema>(MEMO_DOMAIN, MEMO_MIGRATIONS);
  expect(await second.selectFrom("memo_entry").select("name").execute()).toEqual([{ name: "n" }]);
  const ran = (await sql<{ name: string }>`select name from memo_migration`.execute(second)).rows;
  expect(ran.length).toBe(1);
});

test("listing a conversation's entries uses the index made for it, not a scan of every entry", async () => {
  records = await Records.open(":memory:");
  const db = await records.tables<MemoSchema>(MEMO_DOMAIN, MEMO_MIGRATIONS);
  const plan = db.selectFrom("memo_entry").select("name").where("conversation_key", "=", "k").orderBy("updated_at", "desc").compile();
  const rows = (await sql<{ detail: string }>`explain query plan ${sql.raw(plan.sql.replace(/\?/g, "'x'"))}`.execute(db)).rows;
  expect(rows.map((row) => row.detail).join(" ")).toContain("memo_entry_by_key");
});
