/**
 * Which API a session talks to.
 *
 * Everything provider-shaped lives here rather than being spread through `agent.ts`:
 * the credential to look for, the model defaults, and the handful of behaviours that
 * differ once you leave Anthropic. Two kinds of row exist — names NodeLLM already
 * resolves (`anthropic`, `deepseek`), and ones this repo builds itself (`vertex`).
 */
import { createLLM, type NodeLLMCore } from "@node-llm/core";

import type { Config } from "./context.js";
import { VertexProvider, vertexAccessToken } from "./vertex.js";

export interface ProviderSpec {
  /** NodeLLM's name for the provider, and the key its ModelRegistry entries file under. */
  id: string;
  /** Env var holding the API key. Vertex has none: it mints a short-lived token. */
  envVar: string | null;
  /** Field on NodeLLM's config that the key is passed as. */
  configKey: string | null;
  defaultModel: string;
  /** Cheap model for compaction summaries; overridable via config.summaryModel. */
  summaryModel: string;
  /**
   * Whether to send Anthropic's `cache_control`. Every NodeLLM provider spreads
   * unrecognised request keys straight into the JSON body, so sending it to an
   * OpenAI-shaped API puts an unknown top-level field in the request rather than
   * being ignored.
   */
  cacheControl: boolean;
  /**
   * Whether the provider's usage numbers separate cached input from fresh input.
   * DeepSeek's API does report a cache-hit count, but NodeLLM's client drops it before
   * this agent ever sees it, so every token arrives looking uncached. Reporting a flat
   * "0% cached" would be a claim about the run rather than about the data, so the
   * breakdown is omitted for such providers instead.
   */
  reportsCache: boolean;
  /** Registry family and limits for model ids the bundled registry has never heard of. */
  family: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  anthropic: {
    id: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    configKey: "anthropicApiKey",
    defaultModel: "claude-opus-5",
    summaryModel: "claude-haiku-4-5",
    cacheControl: true,
    reportsCache: true,
    family: "claude",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  },
  deepseek: {
    id: "deepseek",
    envVar: "DEEPSEEK_API_KEY",
    configKey: "deepseekApiKey",
    defaultModel: "deepseek-v4-pro",
    // Summaries are throwaway prose, so they run on the cheap chat model rather than
    // the reasoning-heavy default.
    summaryModel: "deepseek-chat",
    // OpenAI-shaped API. DeepSeek caches automatically and has no opt-in parameter.
    cacheControl: false,
    reportsCache: false,
    family: "deepseek",
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
  },
  vertex: {
    id: "vertex",
    envVar: null,
    configKey: null,
    // Vertex model ids carry an @version suffix; there is no floating alias.
    defaultModel: "claude-sonnet-4-5@20250929",
    summaryModel: "claude-haiku-4-5@20251001",
    // The same Claude models behind a different door: cache_control works identically.
    cacheControl: true,
    reportsCache: true,
    family: "claude",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  },
};

export function providerSpec(name: string): ProviderSpec {
  const spec = PROVIDERS[name];
  if (!spec) throw new Error(`Unknown provider "${name}". Known: ${Object.keys(PROVIDERS).join(", ")}.`);
  return spec;
}

/**
 * Every provider's stock model, as the shape the config's "models" map starts at.
 *
 * A fresh config file lists all of them rather than just the active one, so switching
 * provider is a flag away and the model each one runs is visible in a single place.
 */
export function defaultModels(): Record<string, string> {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([name, spec]) => [name, spec.defaultModel]));
}

/**
 * The model to run on a given provider.
 *
 * Keyed by provider rather than held as one global id, because a model id only means
 * anything to the API it belongs to: asking for `--provider deepseek` has to pick up
 * DeepSeek's configured model, not whatever Anthropic was last set to.
 */
export function modelFor(cfg: Config, provider: string): string {
  return cfg.models[provider] || providerSpec(provider).defaultModel;
}

/** The model this session's compaction summariser should use. */
export function summaryModel(cfg: Config, provider: string): string {
  return cfg.summaryModel || providerSpec(provider).summaryModel;
}

/**
 * A configured client for one provider.
 *
 * Throws rather than exiting, so `agent.ts` reports a missing credential through the
 * same path as every other startup failure.
 */
export function createClient(cfg: Config, provider: string): NodeLLMCore {
  const spec = providerSpec(provider);

  if (spec.id === "vertex") {
    const project = cfg.vertexProject || process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) {
      throw new Error(
        `Vertex needs a GCP project. Set "vertexProject" in the config, or VERTEX_PROJECT in the environment.`,
      );
    }
    const region = cfg.vertexRegion || process.env.VERTEX_REGION || "us-east5";
    return createLLM({ provider: new VertexProvider({ project, region, token: vertexAccessToken() }) });
  }

  const key = spec.envVar ? process.env[spec.envVar] : undefined;
  if (!key) throw new Error(`${spec.envVar} is not set.`);
  return createLLM({ provider: spec.id, [spec.configKey as string]: key });
}
