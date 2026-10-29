import { afterEach, expect, test } from "bun:test";

import { sql } from "kysely";

import { Records } from "../../../platform/records/records.ts";
import { zeroCounters } from "../usage.ts";
import { INSIGHTS_DOMAIN, openInsightsStore } from "./index.ts";
import { INSIGHTS_MIGRATIONS } from "./migrations.ts";
import type { InsightsSchema } from "./schema.ts";

let records: Records | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
});

const counters = (totalTokens: number) => ({ ...zeroCounters(), input: totalTokens, totalTokens });

test("counting the same bucket twice adds to it, and a cursor and a listing row are written with it", async () => {
  records = await Records.open(":memory:");
  const store = await openInsightsStore(records);
  const spend = [{ bucket: 5, kind: "model" as const, name: "m", usage: counters(10) }];
  await store.apply({ conversationId: 1, key: "a", lastEntryId: 3, spend, listing: { lastActiveAt: 100 } });
  await store.apply({ conversationId: 1, key: "a", lastEntryId: 7, spend, listing: { lastActiveAt: 50 } });
  expect(await store.spend({})).toEqual([{ bucket: 5, kind: "model", name: "m", usage: counters(20) }]);
  expect(await store.cursorOf(1)).toEqual({ key: "a", lastEntryId: 7 });
  // An earlier time never moves the activity back.
  expect(await store.listingOf("a")).toEqual({ key: "a", conversationId: 1, lastActiveAt: 100 });
  expect(await store.conversationsOf("a")).toEqual([1]);
});

test("spend is asked for by range and by key", async () => {
  records = await Records.open(":memory:");
  const store = await openInsightsStore(records);
  await store.apply({
    conversationId: 1,
    key: "a",
    lastEntryId: 1,
    spend: [1, 2, 3].map((bucket) => ({ bucket, kind: "tool" as const, name: "t", usage: counters(bucket) })),
  });
  await store.apply({ conversationId: 2, key: "b", lastEntryId: 1, spend: [{ bucket: 2, kind: "tool" as const, name: "t", usage: counters(100) }] });
  expect((await store.spend({ from: 2, to: 2 })).map((row) => row.usage.totalTokens)).toEqual([102]);
  expect((await store.spend({ from: 2 }, "a")).map((row) => row.bucket)).toEqual([2, 3]);
  expect(await store.spend({}, "nobody")).toEqual([]);
});

test("a page runs from the most recent, rows without a message last, and a position continues after its row", async () => {
  records = await Records.open(":memory:");
  const store = await openInsightsStore(records);
  const rows = [
    ["old", 10],
    ["new", 30],
    ["mid", 20],
    ["tie", 20],
    ["none-b", undefined],
    ["none-a", undefined],
  ] as const;
  for (const [index, [key, lastActiveAt]] of rows.entries())
    await store.apply({ conversationId: index + 1, key, lastEntryId: 1, spend: [], listing: { lastActiveAt } });
  const order = ["new", "mid", "tie", "old", "none-a", "none-b"];
  expect((await store.page(10)).map((row) => row.key)).toEqual(order);
  for (const [index, key] of order.entries()) {
    const row = (await store.page(10)).find((each) => each.key === key);
    const after = { lastActiveAt: row?.lastActiveAt, key };
    expect((await store.page(10, after)).map((each) => each.key)).toEqual(order.slice(index + 1));
  }
});

test("the listing and a range of spend walk an index", async () => {
  records = await Records.open(":memory:");
  const db = await records.tables<InsightsSchema>(INSIGHTS_DOMAIN, INSIGHTS_MIGRATIONS);
  const plans = [
    db.selectFrom("insights_conversation").selectAll().orderBy("last_active_at", "desc").orderBy("key", "asc").limit(10).compile(),
    db.selectFrom("insights_spend").select("bucket").where("bucket", ">=", 1).where("bucket", "<=", 2).compile(),
    db.selectFrom("insights_cursor").select("conversation_id").where("key", "=", "k").compile(),
  ];
  for (const plan of plans) {
    const rows = (await sql<{ detail: string }>`explain query plan ${sql.raw(plan.sql.replace(/\?/g, "1"))}`.execute(db)).rows;
    const detail = rows.map((row) => row.detail).join(" ");
    expect(detail).toContain("INDEX");
    expect(detail).not.toContain("TEMP B-TREE");
  }
});
