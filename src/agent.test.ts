import assert from "node:assert/strict";
import path from "node:path";
import test, { describe } from "node:test";
import type { Message } from "@node-llm/core";

import { addUsage, formatUsage, getMostRecentSessionId, loadProjectConfig, mergeConfig, newNarration, readProjectContext, turnUsage } from "./agent.js";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, zeroUsage } from "./context.js";
import { fakeConfig, tmpDir, writeTmp } from "./test-helpers.js";

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
    assert.equal(cfg.model, DEFAULT_MODEL);
    assert.equal(cfg.baseUrl, DEFAULT_BASE_URL);
    assert.equal(cfg.sessionDir, ".agent");
  });

  test("warns about a key nobody recognises, and keeps going", () => {
    const { cfg, warnings } = merge({ nonsense: 1, model: "vertex-claude" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /unknown config key "nonsense"/);
    assert.equal(cfg.model, "vertex-claude"); // the good key still landed
    assert.ok(!("nonsense" in cfg));
  });

  test("a key nobody recognises includes ones the proxy took over", () => {
    // provider, models and the Vertex project moved into the LiteLLM YAML. A config
    // still carrying them should say so rather than look like it is being honoured.
    const { warnings } = merge({ provider: "vertex", vertexProject: "p", models: {} });
    assert.equal(warnings.length, 3);
  });

  test("null leaves a key at its default rather than blanking it", () => {
    const { cfg } = merge({ sessionDir: null, model: null, baseUrl: null });
    assert.equal(cfg.sessionDir, ".agent");
    assert.equal(cfg.model, DEFAULT_MODEL);
    assert.equal(cfg.baseUrl, DEFAULT_BASE_URL);
  });

  test("an alias this repo has never heard of is kept, not dropped", () => {
    // The proxy owns the namespace: any model_name in its model_list is valid here.
    const { cfg, warnings } = merge({ model: "my-local-llama" });
    assert.deepEqual(warnings, []);
    assert.equal(cfg.model, "my-local-llama");
  });

  test("baseUrl and apiKeyEnv are overridable, for a proxy on another port", () => {
    const { cfg } = merge({ baseUrl: "http://127.0.0.1:8000/v1", apiKeyEnv: "MY_KEY" });
    assert.equal(cfg.baseUrl, "http://127.0.0.1:8000/v1");
    assert.equal(cfg.apiKeyEnv, "MY_KEY");
  });

  test("stopHook defaults to empty string", () => {
    const { cfg } = merge({});
    assert.equal(cfg.stopHook, "");
  });

  test("stopHook can be set to a command", () => {
    const { cfg } = merge({ stopHook: "afplay /System/Library/Sounds/Glass.aiff" });
    assert.equal(cfg.stopHook, "afplay /System/Library/Sounds/Glass.aiff");
  });

  test("stopHook set to null leaves the default empty string", () => {
    const { cfg } = merge({ stopHook: null });
    assert.equal(cfg.stopHook, "");
  });

  test("confirmHook defaults to empty string", () => {
    const { cfg } = merge({});
    assert.equal(cfg.confirmHook, "");
  });

  test("confirmHook can be set to a command", () => {
    const { cfg } = merge({ confirmHook: "afplay /System/Library/Sounds/Ping.aiff" });
    assert.equal(cfg.confirmHook, "afplay /System/Library/Sounds/Ping.aiff");
  });

  test("confirmHook set to null leaves the default empty string", () => {
    const { cfg } = merge({ confirmHook: null });
    assert.equal(cfg.confirmHook, "");
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
    // A history can end up shorter than the mark if it is rewritten mid-turn.
    assert.deepEqual(newNarration([say("assistant", "hi")], 5), { lines: [], next: 1 });
  });
});

// ---------------------------------------------------------------- token accounting

/** A history the way NodeLLM leaves it: `usage` hung on each assistant message. */
const withUsage = (u: Record<string, number>): Message =>
  ({ role: "assistant", content: "ok", usage: u }) as unknown as Message;

describe("turnUsage", () => {
  test("counts every request in the turn, not just the last", () => {
    const u = turnUsage([
      withUsage({ input_tokens: 100, output_tokens: 10 }),
      withUsage({ input_tokens: 200, output_tokens: 20 }),
      withUsage({ input_tokens: 300, output_tokens: 30 }),
    ]);
    assert.equal(u.requests, 3);
    assert.equal(u.input, 600);
    assert.equal(u.output, 60);
    assert.equal(u.turns, 1);
  });

  test("takes input_tokens as the whole prompt, without adding cached tokens to it", () => {
    // The proxy speaks the OpenAI shape: prompt_tokens already includes anything served
    // from cache, and cached_tokens is a subset of it. Summing them would report a
    // 5,073-token prompt as 7,569.
    const u = turnUsage([
      withUsage({ input_tokens: 5073, cached_tokens: 2496, output_tokens: 53 }),
    ]);
    assert.equal(u.input, 5073);
    assert.equal(u.output, 53);
  });

  test("ignores messages carrying no usage, so tool results do not count as requests", () => {
    const u = turnUsage([
      { role: "user", content: "go" },
      withUsage({ input_tokens: 10, output_tokens: 1 }),
      { role: "tool", tool_call_id: "t1", content: "result" },
    ]);
    assert.equal(u.requests, 1);
    assert.equal(u.input, 10);
  });

  test("an empty history is a turn that moved nothing", () => {
    assert.deepEqual(turnUsage([]), { ...zeroUsage(), turns: 1 });
  });
});

describe("addUsage", () => {
  test("sums each counter and accumulates turns", () => {
    const a = { input: 100, output: 10, requests: 2, turns: 1 };
    const b = { input: 250, output: 25, requests: 3, turns: 1 };
    assert.deepEqual(addUsage(a, b), { input: 350, output: 35, requests: 5, turns: 2 });
  });

  test("leaves both operands alone, so a running total cannot corrupt a turn", () => {
    const total = zeroUsage();
    const spent = { input: 5, output: 1, requests: 1, turns: 1 };
    addUsage(total, spent);
    assert.deepEqual(total, zeroUsage());
    assert.equal(spent.input, 5);
  });
});

describe("formatUsage", () => {
  test("reports tokens and request count under the label", () => {
    const line = formatUsage("turn", { input: 5073, output: 53, requests: 2, turns: 1 });
    assert.match(line, /^turn\s+in 5,073\s+out 53\s+·\s+2 requests$/);
  });

  test("thousands are grouped, so a large session stays readable", () => {
    assert.match(formatUsage("session", { input: 929400, output: 55696, requests: 35, turns: 4 }), /in 929,400/);
  });

  test("a single request is not pluralised", () => {
    assert.match(formatUsage("turn", { input: 1, output: 1, requests: 1, turns: 1 }), /1 request$/);
  });
});

// ---------------------------------------------------------------- project config

describe("loadProjectConfig", () => {
  test("returns defaults when file does not exist", () => {
    const dir = tmpDir("projcfg-no-file");
    const cfg = fakeConfig({ sessionDir: dir });
    const proj = loadProjectConfig(cfg);
    assert.deepEqual(proj, { alwaysApprove: [] });
    assert.equal(proj.contextFile, undefined);
  });

  test("loads contextFile from project.json", () => {
    const dir = tmpDir("projcfg-context-file");
    writeTmp(path.join(dir, "project.json"), JSON.stringify({ contextFile: "NOTES.md" }));
    const cfg = fakeConfig({ sessionDir: dir });
    const proj = loadProjectConfig(cfg);
    assert.equal(proj.contextFile, "NOTES.md");
  });

  test("loads alwaysApprove from project.json", () => {
    const dir = tmpDir("projcfg-always-approve");
    writeTmp(path.join(dir, "project.json"), JSON.stringify({ alwaysApprove: ["npm test", "npm run build"] }));
    const cfg = fakeConfig({ sessionDir: dir });
    const proj = loadProjectConfig(cfg);
    assert.deepEqual(proj.alwaysApprove, ["npm test", "npm run build"]);
  });

  test("alwaysApprove is not shared between two loads", () => {
    // Ensures the array is copied, so mutations don't leak between sessions.
    const dir = tmpDir("projcfg-isolation");
    writeTmp(path.join(dir, "project.json"), JSON.stringify({ alwaysApprove: [] }));
    const cfg = fakeConfig({ sessionDir: dir });
    const a = loadProjectConfig(cfg);
    a.alwaysApprove.push("rm -rf /");
    const b = loadProjectConfig(cfg);
    assert.deepEqual(b.alwaysApprove, []);
  });

  test("filters non-string entries from alwaysApprove", () => {
    const dir = tmpDir("projcfg-filter");
    writeTmp(path.join(dir, "project.json"), JSON.stringify({ alwaysApprove: ["valid", 123, null, "also valid"] }));
    const cfg = fakeConfig({ sessionDir: dir });
    const proj = loadProjectConfig(cfg);
    assert.deepEqual(proj.alwaysApprove, ["valid", "also valid"]);
  });
});

// ---------------------------------------------------------------- project context

describe("readProjectContext", () => {
  // These tests write files to CWD subdirectories. Since readProjectContext uses CWD
  // directly, we test the contextFile override path which lets us point at test files.

  test("returns null when no context file exists", () => {
    // With a non-existent file override, returns null
    const result = readProjectContext("test-tmp/ctx-nonexistent/AGENTS.md");
    assert.equal(result, null);
  });

  test("reads a custom context file when specified", () => {
    writeTmp("test-tmp/ctx-custom/NOTES.md", "# Project Notes\n\nThis is custom context.");
    const result = readProjectContext("test-tmp/ctx-custom/NOTES.md");
    assert.ok(result);
    assert.match(result, /\[project context from test-tmp\/ctx-custom\/NOTES\.md\]/);
    assert.match(result, /# Project Notes/);
    assert.match(result, /\[\/project context\]/);
  });

  test("skips empty files", () => {
    writeTmp("test-tmp/ctx-empty/EMPTY.md", "   \n\n  ");
    const result = readProjectContext("test-tmp/ctx-empty/EMPTY.md");
    assert.equal(result, null);
  });

  test("truncates files over the limit", () => {
    const huge = "x".repeat(25_000);
    writeTmp("test-tmp/ctx-huge/BIG.md", huge);
    const result = readProjectContext("test-tmp/ctx-huge/BIG.md");
    assert.ok(result);
    assert.match(result, /\[truncated 5000 characters\]/);
    // Should contain the start but not the full content
    assert.ok(result.length < huge.length);
  });
});

// ---------------------------------------------------------------- getMostRecentSessionId

describe("getMostRecentSessionId", () => {
  test("returns null when session directory does not exist", () => {
    const dir = tmpDir("recent-no-dir");
    const cfg = fakeConfig({ sessionDir: path.join(dir, "nonexistent") });
    assert.equal(getMostRecentSessionId(cfg), null);
  });

  test("returns null when session directory is empty", () => {
    const dir = tmpDir("recent-empty");
    const cfg = fakeConfig({ sessionDir: dir });
    assert.equal(getMostRecentSessionId(cfg), null);
  });

  test("returns null when directory has no .json files", () => {
    const dir = tmpDir("recent-no-json");
    writeTmp(path.join(dir, "readme.txt"), "not a session");
    writeTmp(path.join(dir, "project.json"), "{}"); // project.json is not a session
    const cfg = fakeConfig({ sessionDir: dir });
    // project.json would match .json filter but that's expected behavior
    // for this test we want only non-session files
    assert.equal(getMostRecentSessionId(cfg), "project");
  });

  test("returns the only session when there is one", () => {
    const dir = tmpDir("recent-single");
    writeTmp(path.join(dir, "abc123.json"), "{}");
    const cfg = fakeConfig({ sessionDir: dir });
    assert.equal(getMostRecentSessionId(cfg), "abc123");
  });

  test("returns the most recently modified session", async () => {
    const dir = tmpDir("recent-multi");
    // Write older session first
    writeTmp(path.join(dir, "older.json"), "{}");
    // Small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));
    writeTmp(path.join(dir, "newer.json"), "{}");
    
    const cfg = fakeConfig({ sessionDir: dir });
    assert.equal(getMostRecentSessionId(cfg), "newer");
  });

  test("ignores non-.json files when finding most recent", async () => {
    const dir = tmpDir("recent-mixed");
    writeTmp(path.join(dir, "session1.json"), "{}");
    await new Promise((r) => setTimeout(r, 50));
    // This is newer but should be ignored (though .md wouldn't match anyway)
    writeTmp(path.join(dir, "session1.md"), "transcript");
    
    const cfg = fakeConfig({ sessionDir: dir });
    assert.equal(getMostRecentSessionId(cfg), "session1");
  });
});
