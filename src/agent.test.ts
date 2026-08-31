import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Message } from "@node-llm/core";

import { mergeConfig, newNarration } from "./agent.js";
import { DEFAULT_PRICING } from "./context.js";

/** mergeConfig warns through a callback, so a test can both silence it and assert on it. */
function merge(raw: Record<string, unknown>): { cfg: ReturnType<typeof mergeConfig>; warnings: string[] } {
  const warnings: string[] = [];
  const cfg = mergeConfig(raw, (m) => warnings.push(m));
  return { cfg, warnings };
}

describe("mergeConfig", () => {
  test("an empty file is exactly the defaults", () => {
    const { cfg, warnings } = merge({});
    assert.deepEqual(warnings, []);
    assert.equal(cfg.provider, "anthropic");
    assert.equal(cfg.models.anthropic, "claude-opus-5");
    assert.equal(cfg.models.deepseek, "deepseek-v4-pro");
  });

  test("warns about a key nobody recognises, and keeps going", () => {
    const { cfg, warnings } = merge({ nonsense: 1, provider: "deepseek" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /unknown config key "nonsense"/);
    assert.equal(cfg.provider, "deepseek"); // the good key still landed
    assert.ok(!("nonsense" in cfg));
  });

  test("null leaves a non-nullable key alone but is honoured on a nullable one", () => {
    const { cfg } = merge({ sessionDir: null, tavilyApiKey: null, summaryModel: null });
    assert.equal(cfg.sessionDir, ".agent");
    assert.equal(cfg.tavilyApiKey, null);
    assert.equal(cfg.summaryModel, null);
  });

  test("models merges per provider, so naming one leaves the others at their defaults", () => {
    const { cfg, warnings } = merge({ models: { deepseek: "deepseek-v4-flash" } });
    assert.deepEqual(warnings, []);
    assert.equal(cfg.models.deepseek, "deepseek-v4-flash");
    assert.equal(cfg.models.anthropic, "claude-opus-5");
    assert.equal(cfg.models.vertex, "claude-sonnet-4-5@20250929");
  });

  test("a model for a provider the table has never heard of is kept, not dropped", () => {
    // The map is open: it is how you point at a model before this repo knows the name.
    const { cfg } = merge({ models: { anthropic: "claude-opus-9" } });
    assert.equal(cfg.models.anthropic, "claude-opus-9");
  });

  test("pricing merges per model over the built-in table", () => {
    const { cfg } = merge({ pricing: { "deepseek/deepseek-v4-pro": { input: 1, output: 2 } } });
    assert.deepEqual(cfg.models, mergeConfig({}, () => {}).models);
    assert.deepEqual(cfg.pricing["deepseek/deepseek-v4-pro"], { input: 1, output: 2 });
    assert.deepEqual(cfg.pricing["anthropic/claude-opus-5"], DEFAULT_PRICING["anthropic/claude-opus-5"]);
  });

  test("neither map is shared between two merges", () => {
    // A shallow spread of DEFAULT_CONFIG would alias them, and --always-approve style
    // in-place edits would then leak from one load to the next.
    const a = mergeConfig({}, () => {});
    a.models.anthropic = "scribbled-on";
    a.pricing["anthropic/claude-opus-5"] = { input: 0, output: 0 };
    const b = mergeConfig({}, () => {});
    assert.equal(b.models.anthropic, "claude-opus-5");
    assert.deepEqual(b.pricing["anthropic/claude-opus-5"], DEFAULT_PRICING["anthropic/claude-opus-5"]);
  });

  describe("the legacy single \"model\" key", () => {
    test("becomes the entry for whichever provider the config selects", () => {
      const { cfg, warnings } = merge({ provider: "deepseek", model: "deepseek-reasoner" });
      assert.deepEqual(warnings, []); // migrated, not reported as junk
      assert.equal(cfg.models.deepseek, "deepseek-reasoner");
      assert.equal(cfg.models.anthropic, "claude-opus-5"); // the others are untouched
    });

    test("defaults to anthropic when the config names no provider", () => {
      const { cfg } = merge({ model: "claude-sonnet-5" });
      assert.equal(cfg.models.anthropic, "claude-sonnet-5");
    });

    test("loses to an explicit models map", () => {
      const { cfg } = merge({ model: "claude-sonnet-5", models: { anthropic: "claude-opus-5" } });
      assert.equal(cfg.models.anthropic, "claude-opus-5");
    });

    test("is ignored when it is not a string", () => {
      const { cfg, warnings } = merge({ model: 42 });
      assert.deepEqual(warnings, []);
      assert.equal(cfg.models.anthropic, "claude-opus-5");
    });
  });
});

describe("newNarration", () => {
  const say = (role: Message["role"], content: string | null): Message => ({ role, content }) as Message;

  test("returns the assistant text added since the high-water mark", () => {
    const history = [say("user", "hi"), say("assistant", "looking now"), say("tool", "result")];
    const { lines, next } = newNarration(history, 0);
    assert.deepEqual(lines, ["looking now"]);
    assert.equal(next, 3);
  });

  test("skips empty, whitespace-only and null assistant content", () => {
    const history = [say("assistant", ""), say("assistant", "   \n "), say("assistant", null)];
    assert.deepEqual(newNarration(history, 0).lines, []);
  });

  test("shows only the first four lines of a long message", () => {
    const long = say("assistant", ["one", "two", "three", "four", "five"].join("\n"));
    assert.deepEqual(newNarration([long], 0).lines, ["one\ntwo\nthree\nfour"]);
  });

  test("a second call from the returned mark repeats nothing", () => {
    const history = [say("assistant", "first")];
    const { next } = newNarration(history, 0);
    history.push(say("assistant", "second"));
    assert.deepEqual(newNarration(history, next).lines, ["second"]);
  });

  test("a resumed session narrates nothing until the model actually speaks", () => {
    // The bug this guards: `chat` is handed the whole restored history before the turn
    // starts, so opening at 0 replayed every past answer on the first tool call.
    const restored = [
      say("system", "instructions"),
      say("user", "the original prompt"),
      say("assistant", "an answer from three turns ago"),
      say("assistant", "and one from last turn"),
    ];
    const opened = restored.length;
    assert.deepEqual(newNarration(restored, opened).lines, []);

    restored.push(say("assistant", "on it"));
    assert.deepEqual(newNarration(restored, opened).lines, ["on it"]);
  });

  test("a mark past the end of a shorter history yields nothing rather than throwing", () => {
    // Compaction rewrites the history mid-turn and can leave it shorter than the mark.
    assert.deepEqual(newNarration([say("assistant", "hi")], 5), { lines: [], next: 1 });
  });
});
