import { section } from "@earendil-works/pi-durable";
import type { PromptSource } from "../../kernel/prompts.ts";
import { WEB_FETCH } from "./web-fetch.ts";
import { WEB_SEARCH } from "./web-search.ts";

/** Marks text from the web as outside content, so the model treats it as information and not as instructions. */
export const webContentSection = (prompts: PromptSource) =>
  section(
    "web-content",
    ({ agent }) => (agent.tools.some((tool) => tool.name === WEB_FETCH || tool.name === WEB_SEARCH) ? prompts.get("system.web-content") : undefined),
    { tag: false },
  );
