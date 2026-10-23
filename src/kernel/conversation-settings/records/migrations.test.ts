import { afterEach, expect, test } from "bun:test";

import { sql } from "kysely";

import { Records } from "../../../platform/records/records.ts";
import { tempDirPerTest } from "../../../testing/testing.ts";
import { SETTING_DOMAIN } from "./index.ts";
import { SETTING_MIGRATIONS } from "./migrations.ts";
import type { SettingSchema } from "./schema.ts";

const dir = tempDirPerTest("setting-migrations-");
let records: Records | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
});

test("the migration makes the settings table, and records that it ran", async () => {
  records = await Records.open(":memory:");
  const db = await records.tables<SettingSchema>(SETTING_DOMAIN, SETTING_MIGRATIONS);
  const names = (await sql<{ name: string }>`select name from sqlite_master where name like 'conversation_%' order by name`.execute(db)).rows.map(
    (row) => row.name,
  );
  expect(names).toEqual(expect.arrayContaining(["conversation_setting", "conversation_migration"]));
  const ran = (await sql<{ name: string }>`select name from conversation_migration`.execute(db)).rows.map((row) => row.name);
  expect(ran).toEqual(["0001_setting"]);
});

test("a row written without updated_by gets the empty default; the key is the conversation and the name", async () => {
  records = await Records.open(":memory:");
  const db = await records.tables<SettingSchema>(SETTING_DOMAIN, SETTING_MIGRATIONS);
  await sql`insert into conversation_setting (conversation_key, name, value, updated_at) values ('k', 'a.b', 'v', 1)`.execute(db);
  const row = await db.selectFrom("conversation_setting").select("updated_by").executeTakeFirstOrThrow();
  expect(row.updated_by).toBe("");
  await expect(sql`insert into conversation_setting (conversation_key, name, value, updated_at) values ('k', 'a.b', 'w', 2)`.execute(db)).rejects.toThrow();
});

test("a second open of the same file runs nothing again and keeps the rows", async () => {
  const path = `${dir()}/app.sqlite`;
  records = await Records.open(path);
  const first = await records.tables<SettingSchema>(SETTING_DOMAIN, SETTING_MIGRATIONS);
  await first.insertInto("conversation_setting").values({ conversation_key: "k", name: "a.b", value: "v", updated_at: 1, updated_by: "" }).execute();
  await records.close();
  records = await Records.open(path);
  const second = await records.tables<SettingSchema>(SETTING_DOMAIN, SETTING_MIGRATIONS);
  expect(await second.selectFrom("conversation_setting").select("value").execute()).toEqual([{ value: "v" }]);
  const ran = (await sql<{ name: string }>`select name from conversation_migration`.execute(second)).rows;
  expect(ran.length).toBe(1);
});

test("listing a conversation's settings walks the key, not every row", async () => {
  records = await Records.open(":memory:");
  const db = await records.tables<SettingSchema>(SETTING_DOMAIN, SETTING_MIGRATIONS);
  const plan = db.selectFrom("conversation_setting").select("name").where("conversation_key", "=", "k").orderBy("name").compile();
  const rows = (await sql<{ detail: string }>`explain query plan ${sql.raw(plan.sql.replace(/\?/g, "'x'"))}`.execute(db)).rows;
  const detail = rows.map((row) => row.detail).join(" ");
  expect(detail).toContain("PRIMARY KEY");
  expect(detail).not.toContain("TEMP B-TREE");
});
