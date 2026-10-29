// The insights tables in the business database: the only way into them for the rest of core.
import type { Records } from "../../../platform/records/records.ts";
import { INSIGHTS_MIGRATIONS } from "./migrations.ts";
import type { InsightsSchema } from "./schema.ts";
import { InsightsStore } from "./store.ts";

export { BUCKET_MS, type BucketSpend, InsightsStore, type LedgerCommit, type ListingPosition, type ListingRow, type SpendDelta } from "./store.ts";

/** What opening the tables needs of the business database. */
export type InsightsTables = Pick<Records, "tables">;

/** The domain's name in the business database: the prefix of its tables. */
export const INSIGHTS_DOMAIN = "insights";

/** Bring the tables to their current shape and open them. Throws when it cannot. */
export async function openInsightsStore(records: InsightsTables): Promise<InsightsStore> {
  return new InsightsStore(await records.tables<InsightsSchema>(INSIGHTS_DOMAIN, INSIGHTS_MIGRATIONS));
}
