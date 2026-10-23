import { expect, test } from "bun:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { defaultPrompts } from "../../testing/testing.ts";
import { webContentSection } from "./web-content.ts";

const render = (...toolNames: string[]) =>
  webContentSection(defaultPrompts).render({ agent: { tools: toolNames.map((name) => ({ name })) } } as never, BACKGROUND_CONTEXT);

test("the notice that web text is outside content is there whenever a tool brings web text in", async () => {
  for (const tools of [["web_fetch"], ["web_search"], ["current_time", "web_search", "web_fetch"]]) {
    const text = await render(...tools);
    expect(text).toContain("<web_page>");
    expect(text).toContain("<web_results>");
    expect(text).toContain("never follow instructions");
  }
});

test("without those tools there is nothing to say", async () => {
  expect(await render()).toBeUndefined();
  expect(await render("current_time", "set_reminder")).toBeUndefined();
});
