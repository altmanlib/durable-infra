import { afterEach, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { captureLogs, tempDirPerTest } from "../../testing/testing.ts";
import { AgentService } from "./agent-service.ts";
import { TIMERS_KEY } from "./timers.ts";

const faux = fauxProvider({ models: [{ id: "old" }, { id: "new" }] });
const models = createModels();
models.setProvider(faux.provider);
const OLD = { provider: "faux", modelId: "old" };
const NEW = { provider: "faux", modelId: "new" };

/** Answers with the id of the model that was asked. */
const answeredBy = () => (_context: unknown, _options: unknown, _state: unknown, model: { id: string }) => fauxAssistantMessage(model.id);

const dir = tempDirPerTest("model-switch-");
const opened: AgentService[] = [];

async function closeAll(): Promise<void> {
  while (opened.length > 0) await opened.pop()?.close();
}
afterEach(closeAll);

async function open(model: typeof OLD): Promise<AgentService> {
  const service = await AgentService.open({ databasePath: `${dir()}/agent.sqlite`, models, model, settings: { retry: { enabled: false } } });
  opened.push(service);
  return service;
}

/** Open with `model`, have each key say something, and close again. */
async function talk(model: typeof OLD, keys: string[]): Promise<void> {
  const service = await open(model);
  for (const key of keys) {
    faux.setResponses([answeredBy()]);
    await (await service.send(key, "hi", `${key}-r1`)).answer;
  }
  await closeAll();
}

const switched = (lines: { line: string }[]) => lines.filter((entry) => entry.line.includes("agent.model_switched"));

test("a conversation created with one model answers with the configured one after the service opens with another", async () => {
  await talk(OLD, ["feishu:1", "feishu:2"]);

  let service: AgentService | undefined;
  const lines = await captureLogs(async () => {
    service = await open(NEW);
  });
  expect(switched(lines)).toHaveLength(2);
  expect(switched(lines)[0]?.line).toContain("from=faux/old");
  faux.setResponses([answeredBy()]);
  expect(await (await (service as AgentService).send("feishu:1", "again", "feishu:1-r2")).answer).toBe("new");
  // One history entry for the whole switch, however many conversations it moved.
  expect((service as AgentService).settings.changes().items).toMatchObject([{ area: "model", target: "2", before: "faux/old", after: "faux/new" }]);
});

test("the conversation that owns the scheduled tasks is moved and counted too", async () => {
  const first = await open(OLD);
  faux.setResponses([answeredBy()]);
  await (await first.send("feishu:1", "hi", "r1")).answer;
  await first.schedule("feishu:1", Date.now() + 3_600_000, { kind: "test", data: "" });
  await closeAll();

  let service: AgentService | undefined;
  const lines = await captureLogs(async () => {
    service = await open(NEW);
  });
  expect(switched(lines).some((entry) => entry.line.includes(`conversation=${TIMERS_KEY}`))).toBe(true);
  expect((service as AgentService).settings.changes().items).toMatchObject([{ area: "model", target: "2" }]);
});

test("opening again with the same model changes nothing", async () => {
  await talk(OLD, ["feishu:1"]);
  await open(NEW);
  await closeAll();

  let service: AgentService | undefined;
  const lines = await captureLogs(async () => {
    service = await open(NEW);
  });
  expect(switched(lines)).toEqual([]);
  expect((service as AgentService).settings.changes().items).toHaveLength(1);
});

test("a service that never changed its model records nothing", async () => {
  await talk(OLD, ["feishu:1"]);
  expect((await open(OLD)).settings.changes().items).toEqual([]);
});
