import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension } from "@earendil-works/pi-durable";

import { fauxSetup, tempDirPerTest } from "../../testing/testing.ts";
import { AgentService, keyOf } from "../index.ts";

const { faux, models, model } = fauxSetup();
const dir = tempDirPerTest("conversation-key-");
let service: AgentService;
const systems: string[] = [];

function respond(transcript: TranscriptContext): AssistantMessage {
  systems.push(
    transcript.messages
      .filter((message) => message.role === "system")
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  return fauxAssistantMessage("ok");
}

beforeEach(async () => {
  systems.length = 0;
  faux.setResponses(Array.from({ length: 10 }, () => respond));
  service = await AgentService.open({
    databasePath: join(dir(), "agent.sqlite"),
    models,
    model,
    extensions: () => [
      defineExtension({
        name: "keyed",
        sections: [{ key: "keyed", render: async (input, context) => `section-for:${await keyOf(input, context)}`, tag: false }],
      }),
    ],
  });
});

afterEach(async () => {
  await service.close();
});

test("a prompt section reads the key of its own conversation, so a request never gets another conversation's text", async () => {
  await (
    await service.send("alpha", "hello", "r1")
  ).answer;
  await (
    await service.send("beta", "hello", "r2")
  ).answer;
  expect(systems).toHaveLength(2);
  expect(systems[0]).toContain("section-for:alpha");
  expect(systems[0]).not.toContain("section-for:beta");
  expect(systems[1]).toContain("section-for:beta");
  expect(systems[1]).not.toContain("section-for:alpha");
});
