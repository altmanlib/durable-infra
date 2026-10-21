import { join } from "node:path";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";

export const CLIPROXY_PROVIDER = "cliproxyapi";

/** Defaults match the default model grok-4.5 (500,000-token context window per docs.x.ai). */
export const DEFAULT_MODEL_ID = "grok-4.5";
export const DEFAULT_CONTEXT_WINDOW = 500_000;
export const DEFAULT_MAX_TOKENS = 8192;

export type CoreConfig = {
  /** The session storage (Durable). */
  databasePath: string;
  /** The business database: records that keep growing. */
  recordsPath: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  /** Context window of the model; compaction thresholds derive from it. */
  contextWindow: number;
  /** Maximum tokens of one model response. */
  maxTokens: number;
};

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

/**
 * Read core configuration from the environment; throws naming the first missing or invalid variable. `dataDir` is where
 * the application keeps its SQLite files; the application decides (`DATA_DIR`, a path under its root).
 */
export function loadCoreConfig(dataDir: string, env: Record<string, string | undefined> = process.env): CoreConfig {
  return {
    databasePath: join(dataDir, "agent.sqlite"),
    recordsPath: join(dataDir, "app.sqlite"),
    baseUrl: requireEnv(env, "LLM_BASE_URL"),
    apiKey: requireEnv(env, "LLM_API_KEY"),
    modelId: env.PI_DURABLE_MODEL || DEFAULT_MODEL_ID,
    contextWindow: positiveIntEnv(env, "PI_DURABLE_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveIntEnv(env, "PI_DURABLE_MAX_TOKENS", DEFAULT_MAX_TOKENS),
  };
}

/** A model of the gateway besides the configured one; the window and the response limit default to the configured model's. */
export type GatewayModel = { id: string; contextWindow?: number; maxTokens?: number };

/**
 * Models with one OpenAI-compatible provider (the local gateway or any compatible endpoint): the configured model and the
 * `extra` ones, which a conversation can be moved to (`AgentService.setModel`).
 */
export function createCliproxyModels(
  config: Pick<CoreConfig, "baseUrl" | "apiKey" | "modelId" | "contextWindow" | "maxTokens">,
  extra: readonly GatewayModel[] = [],
): Models {
  const models = createModels();
  const all: GatewayModel[] = [{ id: config.modelId }, ...extra.filter((model) => model.id !== config.modelId)];
  models.setProvider(
    createProvider({
      id: CLIPROXY_PROVIDER,
      name: "OpenAI-compatible",
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: "LLM API key",
          resolve: async () => ({ auth: { apiKey: config.apiKey }, source: "LLM_API_KEY" }),
        },
      },
      models: all.map((model) => ({
        id: model.id,
        name: model.id,
        api: "openai-completions" as const,
        provider: CLIPROXY_PROVIDER,
        baseUrl: config.baseUrl,
        reasoning: true,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow ?? config.contextWindow,
        maxTokens: model.maxTokens ?? config.maxTokens,
      })),
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
