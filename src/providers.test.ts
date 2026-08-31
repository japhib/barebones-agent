import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { PROVIDERS, createClient, defaultModels, modelFor, providerSpec, summaryModel } from "./providers.js";
import { fakeConfig } from "./test-helpers.js";

describe("providerSpec", () => {
  test("returns a spec for each provider known to the table", () => {
    for (const name of ["anthropic", "deepseek", "vertex"]) {
      const spec = providerSpec(name);
      assert.equal(spec.id, name);
      assert.ok(spec.defaultModel);
      assert.ok(spec.summaryModel);
      assert.equal(typeof spec.contextWindow, "number");
      assert.equal(typeof spec.maxOutputTokens, "number");
    }
  });

  test("throws on an unknown provider", () => {
    assert.throws(() => providerSpec("grok"), /Unknown provider "grok"/);
  });

  test("every provider ships a default and a summary model", () => {
    for (const spec of Object.values(PROVIDERS)) {
      assert.ok(spec.defaultModel, `${spec.id} needs a defaultModel`);
      assert.ok(spec.summaryModel, `${spec.id} needs a summaryModel`);
    }
  });

  test("every entry is addressable by its own id", () => {
    for (const spec of Object.values(PROVIDERS)) {
      assert.equal(PROVIDERS[spec.id], spec);
    }
  });
});

describe("defaultModels", () => {
  test("covers every provider with that provider's own default", () => {
    const models = defaultModels();
    assert.deepEqual(Object.keys(models).sort(), Object.keys(PROVIDERS).sort());
    for (const [name, spec] of Object.entries(PROVIDERS)) {
      assert.equal(models[name], spec.defaultModel);
    }
  });

  test("hands back a fresh object each call, so one config cannot edit another's", () => {
    const a = defaultModels();
    a.anthropic = "scribbled-on";
    assert.notEqual(defaultModels().anthropic, "scribbled-on");
  });

  test("DeepSeek runs v4 pro by default", () => {
    assert.equal(defaultModels().deepseek, "deepseek-v4-pro");
    assert.equal(providerSpec("deepseek").defaultModel, "deepseek-v4-pro");
  });
});

describe("modelFor", () => {
  test("prefers the model configured for that provider", () => {
    const cfg = fakeConfig({ models: { anthropic: "claude-sonnet-5", deepseek: "deepseek-v4-flash" } });
    assert.equal(modelFor(cfg, "anthropic"), "claude-sonnet-5");
    assert.equal(modelFor(cfg, "deepseek"), "deepseek-v4-flash");
  });

  test("reads the asked-for provider, not whichever one is configured as default", () => {
    // The regression this keying exists to prevent: a Claude id sent to DeepSeek's API.
    const cfg = fakeConfig({ provider: "anthropic", models: { anthropic: "claude-opus-5" } });
    assert.equal(modelFor(cfg, "deepseek"), "deepseek-v4-pro");
  });

  test("falls back to the provider default when the map has no entry, or a blank one", () => {
    assert.equal(modelFor(fakeConfig({ models: {} }), "vertex"), providerSpec("vertex").defaultModel);
    assert.equal(modelFor(fakeConfig({ models: { vertex: "" } }), "vertex"), providerSpec("vertex").defaultModel);
  });

  test("throws on an unknown provider rather than returning a blank model", () => {
    assert.throws(() => modelFor(fakeConfig({ models: {} }), "grok"), /Unknown provider "grok"/);
  });
});

describe("summaryModel", () => {
  test("prefers the config override", () => {
    const cfg = fakeConfig({ summaryModel: "my-cheap" });
    assert.equal(summaryModel(cfg, "anthropic"), "my-cheap");
  });

  test("falls back to the provider default", () => {
    // Deliberately not the v4-pro default: summaries are throwaway prose.
    assert.equal(summaryModel(fakeConfig({ summaryModel: null }), "deepseek"), "deepseek-chat");
    assert.equal(summaryModel(fakeConfig({ summaryModel: null }), "vertex"), "claude-haiku-4-5@20251001");
  });
});

describe("createClient", () => {
  const ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "VERTEX_PROJECT",
    "VERTEX_ACCESS_TOKEN",
    "GOOGLE_ACCESS_TOKEN",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  /** Blank every relevant env var and record what to restore. */
  function blankEnv(): void {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  /** Put the environment back the way it was. */
  function restoreEnv(): void {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  test("throws a helpful error when the API key is missing", () => {
    blankEnv();
    try {
      assert.throws(() => createClient(fakeConfig(), "anthropic"), /ANTHROPIC_API_KEY is not set/);
      assert.throws(() => createClient(fakeConfig(), "deepseek"), /DEEPSEEK_API_KEY is not set/);
    } finally {
      restoreEnv();
    }
  });

  test("returns a configured client given the right env var", () => {
    blankEnv();
    try {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      const client = createClient(fakeConfig(), "anthropic");
      assert.equal(typeof (client as { chat: unknown }).chat, "function");
    } finally {
      restoreEnv();
    }
  });

  test("Vertex demands a project", () => {
    blankEnv();
    try {
      assert.throws(() => createClient(fakeConfig(), "vertex"), /Vertex needs a GCP project/);
    } finally {
      restoreEnv();
    }
  });

  test("Vertex takes the project from config or the environment", () => {
    blankEnv();
    try {
      process.env.VERTEX_ACCESS_TOKEN = "tok";
      const cfg = fakeConfig({ vertexProject: "acme" });
      const client = createClient(cfg, "vertex");
      assert.equal(typeof (client as { chat: unknown }).chat, "function");

      process.env.VERTEX_PROJECT = "acme-env";
      const cfg2 = fakeConfig({ vertexProject: null });
      assert.equal(typeof (createClient(cfg2, "vertex") as { chat: unknown }).chat, "function");
    } finally {
      restoreEnv();
    }
  });

  test("Vertex reads GOOGLE_CLOUD_PROJECT as a fallback project", () => {
    blankEnv();
    try {
      process.env.VERTEX_ACCESS_TOKEN = "tok";
      process.env.GOOGLE_CLOUD_PROJECT = "gcp-fallback";
      const client = createClient(fakeConfig({ vertexProject: null }), "vertex");
      assert.equal(typeof (client as { chat: unknown }).chat, "function");
    } finally {
      restoreEnv();
    }
  });
});
