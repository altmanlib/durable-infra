import { Insights, type InsightsOptions } from "../kernel/insights/insights.ts";
import { UsageLedger } from "../kernel/insights/ledger.ts";
import { openInsightsStore } from "../kernel/insights/records/index.ts";
import { AgentService, type AgentServiceOptions } from "../kernel/service/agent-service.ts";
import { Records } from "../platform/records/records.ts";

export type LedgeredService = {
  service: AgentService;
  ledger: UsageLedger;
  records: Records;
  /** Queries over the service, with the ledger counting its commits. */
  insights(options?: InsightsOptions): Insights;
  close(): Promise<void>;
};

/** Opens a service the way `openCore` does with the ledger: counting from the start, caught up before it returns. `recordsPath` defaults to memory; give a file to reopen the same ledger. */
export async function openLedgered(options: Omit<AgentServiceOptions, "onCommit">, recordsPath = ":memory:"): Promise<LedgeredService> {
  const records = await Records.open(recordsPath);
  const ledger = new UsageLedger(await openInsightsStore(records));
  const service = await AgentService.open({ ...options, onCommit: ledger.observe });
  await ledger.start(service.reader);
  return {
    service,
    ledger,
    records,
    insights: (insightsOptions) => new Insights(service.reader, ledger, insightsOptions),
    close: async () => {
      try {
        await service.close();
        await ledger.close();
      } finally {
        await records.close();
      }
    },
  };
}
