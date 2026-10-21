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
  expect((await (service as AgentService).settings.changes()).items).toMatchObject([{ area: "model", target: "2", before: "faux/old", after: "faux/new" }]);
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
  expect((await (service as AgentService).settings.changes()).items).toMatchObject([{ area: "model", target: "2" }]);
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
  expect((await (service as AgentService).settings.changes()).items).toHaveLength(1);
});

test("a service that never changed its model records nothing", async () => {
  await talk(OLD, ["feishu:1"]);
  expect((await (await open(OLD)).settings.changes()).items).toEqual([]);
});

const BOTH = [OLD, NEW];

async function openWith(model: typeof OLD, catalog?: readonly (typeof OLD)[]): Promise<AgentService> {
  const service = await AgentService.open({
    databasePath: `${dir()}/agent.sqlite`,
    models,
    model,
    ...(catalog ? { catalog } : {}),
    settings: { retry: { enabled: false } },
  });
  opened.push(service);
  return service;
}

const ask = async (service: AgentService, key: string, id: string): Promise<string> => {
  faux.setResponses([answeredBy()]);
  return (await (
    await service.send(key, "hi", id)
  ).answer) as string;
};

test("a conversation moved to another model of the catalog answers with it, and keeps it across a restart that has both", async () => {
  const service = await openWith(OLD, BOTH);
  expect(await ask(service, "feishu:1", "r1")).toBe("old");
  expect(await service.setModel("feishu:1", NEW)).toBe("saved");
  expect(await service.modelOf("feishu:1")).toEqual(NEW);
  expect(await ask(service, "feishu:1", "r2")).toBe("new");
  // Another conversation is not touched.
  expect(await ask(service, "feishu:2", "r3")).toBe("old");

  await closeAll();
  const again = await openWith(OLD, BOTH);
  expect(await again.modelOf("feishu:1")).toEqual(NEW);
  expect(await ask(again, "feishu:1", "r4")).toBe("new");
});

test("a model outside the catalog is refused and nothing is written", async () => {
  const service = await openWith(OLD, BOTH);
  await ask(service, "feishu:1", "r1");
  expect(await service.setModel("feishu:1", { provider: "faux", modelId: "ghost" })).toBe("unknown_model");
  const single = await openWith(OLD);
  expect(await single.setModel("feishu:1", NEW)).toBe("unknown_model");
  expect(await single.modelOf("feishu:1")).toEqual(OLD);
  expect((await single.settings.changes()).items).toEqual([]);
});

test("the same model is unchanged and leaves no history; a move records the key and both models", async () => {
  const service = await openWith(OLD, BOTH);
  await ask(service, "feishu:1", "r1");
  expect(await service.setModel("feishu:1", OLD)).toBe("unchanged");
  expect((await service.settings.changes()).items).toEqual([]);
  expect(await service.setModel("feishu:1", NEW)).toBe("saved");
  expect((await service.settings.changes()).items).toMatchObject([{ area: "conversation-model", target: "feishu:1", before: "faux/old", after: "faux/new" }]);
});

test("a conversation that does not exist yet is created on the chosen model", async () => {
  const service = await openWith(OLD, BOTH);
  expect(await service.modelOf("feishu:9")).toEqual(OLD);
  expect(await service.setModel("feishu:9", NEW)).toBe("saved");
  expect(await ask(service, "feishu:9", "r1")).toBe("new");
});

test("opening with a catalog that dropped a model moves its conversations to the default and keeps the others", async () => {
  const first = await openWith(OLD, BOTH);
  await ask(first, "feishu:1", "r1");
  await ask(first, "feishu:2", "r2");
  await first.setModel("feishu:2", NEW);
  await closeAll();

  const lines = await captureLogs(async () => {
    await openWith(OLD);
  });
  expect(switched(lines)).toHaveLength(1);
  expect(switched(lines)[0]?.line).toContain("conversation=feishu:2");
});

test("a catalog that does not hold the default, crosses providers or names an unknown model is refused at open", async () => {
  const fails = (catalog: { provider: string; modelId: string }[]) =>
    openWith(OLD, catalog).then(
      () => false,
      () => true,
    );
  expect(await fails([NEW])).toBe(true);
  expect(await fails([OLD, { provider: "other", modelId: "x" }])).toBe(true);
  expect(await fails([OLD, { provider: "faux", modelId: "ghost" }])).toBe(true);
  expect(await fails([OLD, NEW])).toBe(false);
});
