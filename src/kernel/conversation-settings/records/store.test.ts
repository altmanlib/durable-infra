import { afterEach, expect, test } from "bun:test";

import { Records } from "../../../platform/records/records.ts";
import { openSettingStore, type SettingRows } from "./index.ts";

let records: Records | undefined;
afterEach(async () => {
  await records?.close();
  records = undefined;
});

let clock = 1_000;
async function open(): Promise<SettingRows> {
  records = await Records.open(":memory:");
  clock = 1_000;
  return openSettingStore(records, { now: () => clock });
}

test("write keeps a setting, read finds it, and a second write replaces it with the new time and writer", async () => {
  const rows = await open();
  expect(await rows.read("feishu:oc_1", "gitea.repo")).toBeUndefined();
  await rows.write("feishu:oc_1", "gitea.repo", "team/app", "ou_a");
  expect(await rows.read("feishu:oc_1", "gitea.repo")).toBe("team/app");
  clock = 2_000;
  await rows.write("feishu:oc_1", "gitea.repo", "team/web", "ou_b");
  expect(await rows.list("feishu:oc_1")).toEqual([{ name: "gitea.repo", value: "team/web", updatedAt: 2_000, updatedBy: "ou_b" }]);
});

test("writing the same value again refreshes when and by whom", async () => {
  const rows = await open();
  await rows.write("k", "a.b", "v", "ou_a");
  clock = 3_000;
  await rows.write("k", "a.b", "v", "ou_b");
  expect(await rows.list("k")).toEqual([{ name: "a.b", value: "v", updatedAt: 3_000, updatedBy: "ou_b" }]);
});

test("conversations do not see each other's settings; list is by name", async () => {
  const rows = await open();
  await rows.write("a", "x.z", "1", "");
  await rows.write("a", "x.y", "2", "");
  await rows.write("b", "x.y", "of b", "");
  expect((await rows.list("a")).map((row) => row.name)).toEqual(["x.y", "x.z"]);
  expect(await rows.remove("a", "x.y")).toBe("cleared");
  expect(await rows.read("b", "x.y")).toBe("of b");
  expect(await rows.list("c")).toEqual([]);
});

test("remove is idempotent: a second one finds nothing, which is no failure", async () => {
  const rows = await open();
  await rows.write("k", "a.b", "v", "");
  expect(await rows.remove("k", "a.b")).toBe("cleared");
  expect(await rows.remove("k", "a.b")).toBe("missing");
  expect(await rows.read("k", "a.b")).toBeUndefined();
});

test("a write that fails throws instead of pretending it was kept", async () => {
  const rows = await open();
  await records?.close();
  records = undefined;
  await expect(rows.write("k", "a.b", "v", "")).rejects.toThrow();
  await expect(rows.remove("k", "a.b")).rejects.toThrow();
});
