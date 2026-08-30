import assert from "node:assert/strict";
import path from "node:path";
import test, { describe } from "node:test";

import { CWD, MAX_TOOL_OUTPUT, cap, ctx, priceFor, resolveSafe, zeroUsage } from "./context.js";
import { fakeConfig, useContext } from "./test-helpers.js";

describe("resolveSafe", () => {
  test("resolves paths inside the project to absolute", () => {
    useContext();
    assert.equal(resolveSafe("src/agent.ts"), path.join(CWD, "src/agent.ts"));
    assert.equal(resolveSafe("./src/../README.md"), path.join(CWD, "README.md"));
    assert.equal(resolveSafe("."), CWD); // the root itself is allowed
  });

  test("refuses anything that escapes the current directory", () => {
    useContext();
    for (const p of ["../secrets.txt", "src/../../etc/passwd", "/etc/passwd", "~/../etc"]) {
      assert.throws(() => resolveSafe(p), /resolves outside the current directory/, p);
    }
  });

  test("refuses a sibling directory that merely shares the CWD prefix", () => {
    useContext();
    // The guard compares against CWD + path.sep for exactly this case: a directory
    // named e.g. "barebones-agent-secrets" starts with CWD as a string but is outside.
    assert.throws(() => resolveSafe(`../${path.basename(CWD)}-secrets/key`), /resolves outside/);
  });

  test("refuses .git and the session directory at any depth", () => {
    useContext({ cfg: { sessionDir: ".agent" } });
    assert.throws(() => resolveSafe(".git/config"), /is inside \.git\//);
    assert.throws(() => resolveSafe("src/.git/HEAD"), /is inside \.git\//);
    assert.throws(() => resolveSafe(".agent/abc.md"), /is inside \.agent\//);
  });

  test("follows a reconfigured session directory", () => {
    useContext({ cfg: { sessionDir: ".sessions" } });
    assert.throws(() => resolveSafe(".sessions/abc.json"), /is inside \.sessions\//);
    assert.doesNotThrow(() => resolveSafe(".agent/abc.json")); // no longer the guarded one
  });

  test("matches whole path segments, not substrings", () => {
    useContext();
    // ".gitignore" and "git/" both contain the guarded name; neither is ".git".
    assert.doesNotThrow(() => resolveSafe(".gitignore"));
    assert.doesNotThrow(() => resolveSafe("src/git/index.ts"));
    assert.doesNotThrow(() => resolveSafe("agent/notes.md"));
  });
});

describe("cap", () => {
  test("leaves output at or under the limit untouched", () => {
    assert.equal(cap("hello"), "hello");
    assert.equal(cap("x".repeat(10), 10), "x".repeat(10));
  });

  test("truncates and reports how much was dropped", () => {
    const capped = cap("x".repeat(25), 10);
    assert.equal(capped, `${"x".repeat(10)}\n… truncated 15 more characters.`);
  });

  test("defaults to MAX_TOOL_OUTPUT", () => {
    const capped = cap("y".repeat(MAX_TOOL_OUTPUT + 5));
    assert.ok(capped.startsWith("y".repeat(MAX_TOOL_OUTPUT)));
    assert.ok(capped.endsWith("truncated 5 more characters."));
  });
});

describe("context handle", () => {
  test("ctx() returns the most recently installed context by identity", () => {
    // Not "throws before setContext": the module-scope handle is process-wide, and
    // earlier tests in this file have already installed one.
    const first = useContext({ session: { mode: "plan" } });
    assert.equal(ctx(), first);
    assert.equal(ctx().session.mode, "plan");

    const second = useContext({ session: { mode: "act" } });
    assert.equal(ctx(), second);
    assert.equal(ctx().session.mode, "act");
  });
});

test("zeroUsage starts at zero and counts as fully priced", () => {
  // `priced` starts true so that a session with no requests is not reported as "$0+".
  assert.deepEqual(zeroUsage(), {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    requests: 0,
    turns: 0,
    costUsd: 0,
    priced: true,
  });
});

describe("priceFor", () => {
  test("prefers the provider's own rate over a bare model id", () => {
    const cfg = fakeConfig({
      pricing: { "claude-opus-5": { input: 1, output: 1 }, "anthropic/claude-opus-5": { input: 5, output: 25 } },
    });
    assert.equal(priceFor(cfg, "anthropic", "claude-opus-5")?.input, 5);
  });

  test("still honours a bare model id, which is what older configs contain", () => {
    const cfg = fakeConfig({ pricing: { "claude-opus-5": { input: 5, output: 25 } } });
    assert.equal(priceFor(cfg, "anthropic", "claude-opus-5")?.input, 5);
  });

  test("strips Vertex's @version suffix", () => {
    assert.equal(priceFor(fakeConfig(), "vertex", "claude-sonnet-4-5@20250929")?.input, 3);
  });

  test("keeps two providers' rates for the same model name apart", () => {
    const cfg = fakeConfig({
      pricing: { "anthropic/shared": { input: 5, output: 25 }, "deepseek/shared": { input: 0.28, output: 0.42 } },
    });
    assert.equal(priceFor(cfg, "anthropic", "shared")?.input, 5);
    assert.equal(priceFor(cfg, "deepseek", "shared")?.input, 0.28);
  });

  test("returns nothing for a model no table knows", () => {
    assert.equal(priceFor(fakeConfig(), "deepseek", "deepseek-v4-pro"), undefined);
  });
});
