import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { PROVIDERS, createClient, providerSpec, summaryModel } from "./providers.js";
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

describe("summaryModel", () => {
  test("prefers the config override", () => {
    const cfg = fakeConfig({ summaryModel: "my-cheap" });
    assert.equal(summaryModel(cfg, "anthropic"), "my-cheap");
  });

  test("falls back to the provider default", () => {
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
