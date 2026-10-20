import { describe, expect, test } from "bun:test";
import { createCliproxyModels, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_MODEL_ID, loadCoreConfig } from "./config.ts";

const base = { LLM_BASE_URL: "http://localhost/v1", LLM_API_KEY: "key" };

describe("loadCoreConfig", () => {
  test("uses defaults when optional variables are unset or empty", () => {
    for (const extra of [{}, { PI_DURABLE_MODEL: "", PI_DURABLE_CONTEXT_WINDOW: "", PI_DURABLE_MAX_TOKENS: "" }]) {
      const config = loadCoreConfig("/data", { ...base, ...extra });
      expect(config.modelId).toBe(DEFAULT_MODEL_ID);
      expect(config.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
      expect(config.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    }
  });

  test("keeps both databases under the data directory it is given", () => {
    const config = loadCoreConfig("/data", base);
    expect(config.databasePath).toBe("/data/agent.sqlite");
    expect(config.recordsPath).toBe("/data/app.sqlite");
  });

  test("reads model parameters from the environment", () => {
    const config = loadCoreConfig("/data", { ...base, PI_DURABLE_MODEL: "grok-4.7", PI_DURABLE_CONTEXT_WINDOW: "200000", PI_DURABLE_MAX_TOKENS: "4096" });
    expect(config).toMatchObject({ modelId: "grok-4.7", contextWindow: 200_000, maxTokens: 4096 });
  });

  test.each(["abc", "0", "-5", "1.5", "1e3x"])("rejects invalid PI_DURABLE_CONTEXT_WINDOW %p", (value) => {
    expect(() => loadCoreConfig("/data", { ...base, PI_DURABLE_CONTEXT_WINDOW: value })).toThrow("PI_DURABLE_CONTEXT_WINDOW");
  });

  test("rejects invalid PI_DURABLE_MAX_TOKENS", () => {
    expect(() => loadCoreConfig("/data", { ...base, PI_DURABLE_MAX_TOKENS: "0" })).toThrow("PI_DURABLE_MAX_TOKENS");
  });

  test("still requires the model gateway variables", () => {
    expect(() => loadCoreConfig("/data", {})).toThrow("LLM_BASE_URL");
  });
});

describe("createCliproxyModels", () => {
  test("passes the configured parameters to the model", async () => {
    const config = loadCoreConfig("/data", { ...base, PI_DURABLE_CONTEXT_WINDOW: "300000", PI_DURABLE_MAX_TOKENS: "3000" });
    const models = createCliproxyModels(config);
    const model = await models.getModel("cliproxyapi", config.modelId);
    expect(model).toMatchObject({ contextWindow: 300_000, maxTokens: 3000 });
  });
});
