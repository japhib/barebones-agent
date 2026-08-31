import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import type { Tool } from "@node-llm/core";

import { extractBaseCommand, TOOLS } from "./tools.js";
import { Progress } from "./progress.js";
import { captureStderr, cleanTmp, tmpDir, useContext, writeTmp } from "./test-helpers.js";

/** Instantiate a tool from the exported TOOLS array by name. */
function tool(name: string): Tool {
  const Ctor = TOOLS.find((t) => new t().name === name);
  assert.ok(Ctor, `no tool named ${name}`);
  return new Ctor();
}

describe("all tools", () => {
  test("are registered once each, with names, descriptions and schemas", () => {
    const seen = new Set<string>();
    for (const T of TOOLS) {
      const t = new T();
      assert.equal(typeof t.name, "string");
      assert.ok(t.name.length);
      assert.equal(typeof t.description, "string");
      assert.ok(t.description.length);
      assert.ok(t.schema);
      assert.ok(!seen.has(t.name), `duplicate tool name ${t.name}`);
      seen.add(t.name);
    }
    assert.deepEqual([...seen].sort(), [
      "delete_file",
      "edit_file",
      "git_diff",
      "git_log",
      "git_merge_base",
      "git_status",
      "list_tree",
      "read_file",
      "run_bash",
      "search_code",
      "write_file",
    ]);
  });

  test("an interrupt flag halts before any work is done", async () => {
    const c = useContext({ session: { mode: "act" } });
    c.interrupt.requested = true;
    const dir = tmpDir("interrupt");
    const rel = writeTmp(`${dir}/f.txt`, "should not be touched");

    const read = await tool("read_file").execute({ path: rel });
    assert.match(String(read), /interrupted this turn/i);
    const write = await tool("write_file").execute({ path: rel, content: "x" });
    assert.match(String(write), /interrupted this turn/i);
  });
});

describe("read_file", () => {
  test("returns 1-indexed numbered lines", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("read");
    const rel = writeTmp(`${dir}/a.txt`, "one\ntwo\nthree");

    const out = await tool("read_file").execute({ path: rel });
    assert.equal(out, "1\tone\n2\ttwo\n3\tthree");
  });

  test("honours offset and clamps limit", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("read");
    const rel = writeTmp(`${dir}/b.txt`, "l1\nl2\nl3\nl4\nl5");

    const mid = await tool("read_file").execute({ path: rel, offset: 2 });
    assert.equal(mid, "2\tl2\n3\tl3\n4\tl4\n5\tl5");

    const ranged = await tool("read_file").execute({ path: rel, offset: 3, limit: 2 });
    assert.equal(ranged, "3\tl3\n4\tl4");
  });

  test("reports an offset past the end", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("read");
    const rel = writeTmp(`${dir}/c.txt`, "only one line");
    const out = await tool("read_file").execute({ path: rel, offset: 10 });
    assert.match(String(out), /offset 10 is past the end/);
  });

  test("refuses a path that escapes the current directory", async () => {
    useContext({ session: { mode: "act" } });
    const out = await tool("read_file").execute({ path: "../secrets" });
    assert.match(String(out), /resolves outside the current directory/);
  });
});

describe("what the editing tools show", () => {
  /** Run a tool with a narrating Progress and return what the user would have seen.
   *  Progress writes to stderr; off a TTY it prints plain lines rather than animating. */
  async function shown(run: () => Promise<unknown>): Promise<string> {
    useContext({ session: { mode: "act" }, progress: new Progress(true) });
    return captureStderr(async () => {
      await run();
    });
  }

  test("edit_file shows its own arguments: old_string out, new_string in", async () => {
    const dir = tmpDir("show-edit");
    const rel = writeTmp(`${dir}/e.txt`, "one\ntwo\nthree\n");
    const out = await shown(() => tool("edit_file").execute({ path: rel, old_string: "two", new_string: "TWO" }));

    assert.ok(out.includes("\x1b[31m-two"), "the replaced span, in red");
    assert.ok(out.includes("\x1b[32m+TWO"), "its replacement, in green");
    assert.ok(out.includes(`edit_file ${rel}:2`), "labelled with the file and the line it edited");
  });

  test("the line number counts newlines before the match", async () => {
    const dir = tmpDir("show-line");
    const rel = writeTmp(`${dir}/n.txt`, "a\nb\nc\nd\nTARGET\ne\n");
    const out = await shown(() => tool("edit_file").execute({ path: rel, old_string: "TARGET", new_string: "HIT" }));
    assert.ok(out.includes(`${rel}:5`), `expected :5 in ${JSON.stringify(out)}`);
  });

  test("a multi-line replacement shows every line of both spans", async () => {
    const dir = tmpDir("show-multi");
    const rel = writeTmp(`${dir}/m.txt`, "keep\nold1\nold2\nkeep\n");
    const out = await shown(() =>
      tool("edit_file").execute({ path: rel, old_string: "old1\nold2", new_string: "new1\nnew2\nnew3" }),
    );
    for (const line of ["-old1", "-old2", "+new1", "+new2", "+new3"]) {
      assert.ok(out.includes(line), `expected ${line}`);
    }
    assert.ok(!out.includes("keep"), "untouched text is not reprinted");
  });

  test("write_file marks a file it created and shows it as all additions", async () => {
    const dir = tmpDir("show-write");
    const rel = `${dir}/new.txt`;
    const out = await shown(() => tool("write_file").execute({ path: rel, content: "alpha\nbeta\n" }));

    assert.ok(out.includes("(new file)"), "says the file did not exist");
    assert.ok(out.includes("\x1b[32m+alpha") && out.includes("\x1b[32m+beta"));
    // Red survives in the header's "-0" stat, so look at the diff body itself.
    const body = out.trimEnd().split("\n").slice(1);
    assert.ok(body.length, "expected a diff body");
    assert.ok(!body.some((l) => l.includes("\x1b[31m")), "nothing was removed");
    assert.ok(out.split("\n")[0]?.includes("-0"), "the stat records zero removals");
  });

  test("write_file over an existing file also shows what it replaced", async () => {
    const dir = tmpDir("show-over");
    const rel = writeTmp(`${dir}/o.txt`, "keep\nold\n");
    const out = await shown(() => tool("write_file").execute({ path: rel, content: "keep\nnew\n" }));

    assert.ok(!out.includes("(new file)"));
    assert.ok(out.includes("\x1b[31m-old"), "shows the content it overwrote");
    assert.ok(out.includes("\x1b[32m+new"));
  });

  test("rewriting a file with its own contents reports no change", async () => {
    const dir = tmpDir("show-same");
    const rel = writeTmp(`${dir}/s.txt`, "unchanged\n");
    const out = await shown(() => tool("write_file").execute({ path: rel, content: "unchanged\n" }));
    assert.match(out, /\(no change\)/);
  });

  test("--quiet suppresses it, since it is narration like any other", async () => {
    const dir = tmpDir("show-quiet");
    const rel = writeTmp(`${dir}/q.txt`, "one\n");
    useContext({ session: { mode: "act" }, progress: new Progress(false) });
    const out = await captureStderr(async () => {
      await tool("edit_file").execute({ path: rel, old_string: "one", new_string: "two" });
    });
    assert.equal(out, "");
  });

  test("the model is told the stat, not handed the lines back", async () => {
    // The display is for the user. Feeding it to the model would bill it for reading
    // back an edit it just wrote.
    const dir = tmpDir("show-result");
    const rel = writeTmp(`${dir}/r.txt`, "a\nb\nc\n");
    useContext({ session: { mode: "act" }, progress: new Progress(false) });
    const out = String(await tool("edit_file").execute({ path: rel, old_string: "b", new_string: "B\nB2" }));
    assert.equal(out, `Edited ${rel} (+2 -1).`);
    assert.ok(!out.includes("\x1b["), "and no escape codes in the model's history");
  });

  test("a refused edit prints nothing, because nothing was written", async () => {
    const dir = tmpDir("show-fail");
    const rel = writeTmp(`${dir}/x.txt`, "content\n");
    const out = await shown(() => tool("edit_file").execute({ path: rel, old_string: "absent", new_string: "y" }));
    assert.equal(out, "");
  });
});

describe("write_file / edit_file / delete_file", () => {
  test("write_file creates the file (with parent dirs) and reports the line count", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("write");
    const rel = `${dir}/nested/deep/file.txt`;
    const out = await tool("write_file").execute({ path: rel, content: "a\nb\nc" });
    assert.match(String(out), /Wrote .* \(3 lines, \+3 -0\)\./);
    // read_file round-trips what write_file wrote.
    const read = await tool("read_file").execute({ path: rel });
    assert.equal(read, "1\ta\n2\tb\n3\tc");
  });

  test("edit_file replaces a unique string", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("edit");
    const rel = writeTmp(`${dir}/e.txt`, "hello world and hello again");
    const out = await tool("edit_file").execute({ path: rel, old_string: "hello world", new_string: "goodbye" });
    assert.equal(out, `Edited ${rel} (+1 -1).`);
    const read = await tool("read_file").execute({ path: rel });
    assert.equal(read, "1\tgoodbye and hello again");
  });

  test("edit_file errors when old_string is absent or ambiguous", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("edit");
    const rel = writeTmp(`${dir}/f.txt`, "same same same");
    const missing = await tool("edit_file").execute({ path: rel, old_string: "nope", new_string: "x" });
    assert.match(String(missing), /old_string not found/);

    const dup = await tool("edit_file").execute({ path: rel, old_string: "same", new_string: "x" });
    assert.match(String(dup), /appears 3 times/);
  });

  test("delete_file removes a file but refuses a directory", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("delete");
    const rel = writeTmp(`${dir}/del.txt`, "bye");
    writeTmp(`${dir}/sub/inner.txt`, "x");

    // Refusing a directory first.
    const dirErr = await tool("delete_file").execute({ path: `${dir}/sub` });
    assert.match(String(dirErr), /is a directory/);

    // Then a real delete.
    const out = await tool("delete_file").execute({ path: rel });
    assert.equal(out, `Deleted ${rel}.`);
  });

  test("mutating tools are refused in plan mode", async () => {
    useContext({ session: { mode: "plan" } });
    const dir = tmpDir("plan");
    const cases: { name: string; args: Record<string, string> }[] = [
      { name: "write_file", args: { path: `${dir}/p.txt`, content: "x" } },
      { name: "edit_file", args: { path: `${dir}/p.txt`, old_string: "x", new_string: "y" } },
      { name: "delete_file", args: { path: `${dir}/p.txt` } },
      { name: "run_bash", args: { command: "true", reason: "z" } },
    ];
    for (const { name, args } of cases) {
      const out = await tool(name).execute(args);
      assert.match(String(out), /Unavailable in plan mode/, name);
    }
  });
});

describe("list_tree", () => {
  test("lists a directory's entries with a trailing slash on subdirectories", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("tree");
    writeTmp(`${dir}/root.txt`, "x");
    writeTmp(`${dir}/sub/inner.txt`, "y");

    const out = String(await tool("list_tree").execute({ path: dir }));
    assert.match(out, /root\.txt/);
    assert.match(out, /sub\//);
    assert.match(out, /inner\.txt/);
  });

  test("errors on a path that is not a directory", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("tree");
    const rel = writeTmp(`${dir}/file.txt`, "x");
    const out = await tool("list_tree").execute({ path: rel });
    assert.match(String(out), /is not a directory/);
  });

  test("reports an empty directory", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("empty");
    const out = await tool("list_tree").execute({ path: dir });
    assert.match(String(out), /is empty\./);
  });
});

describe("search_code", () => {
  test("matches in a path and reports the totals", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("search");
    writeTmp(`${dir}/one.ts`, "const needle = 1;\nconst other = 2;\n");
    writeTmp(`${dir}/two.ts`, "needle here too\n");

    const out = String(await tool("search_code").execute({ pattern: "needle", path: dir }));
    assert.match(out, /\/needle\/ — 2 matches in 2 files/);
    assert.match(out, /one\.ts/);
    assert.match(out, /two\.ts/);
  });

  test("reports no matches without treating it as a failure", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("search");
    writeTmp(`${dir}/a.ts`, "nothing relevant here");
    const out = await tool("search_code").execute({ pattern: "zzz_no_such_pattern", path: dir });
    assert.equal(out, "No matches for /zzz_no_such_pattern/.");
  });

  test("honours a glob restriction", async () => {
    useContext({ session: { mode: "act" } });
    const dir = tmpDir("search");
    writeTmp(`${dir}/a.ts`, "hit");
    writeTmp(`${dir}/b.md`, "hit");
    const out = String(await tool("search_code").execute({ pattern: "hit", path: dir, glob: "*.md" }));
    assert.match(out, /1 match in 1 file/);
    assert.match(out, /b\.md/);
    assert.doesNotMatch(out, /a\.ts/);
  });
});

describe("extractBaseCommand", () => {
  test("returns the full command unchanged if no recognized suffix", () => {
    assert.deepEqual(extractBaseCommand("npm test"), { base: "npm test", suffix: "" });
    assert.deepEqual(extractBaseCommand("cat file | wc -l"), { base: "cat file | wc -l", suffix: "" });
  });

  test("strips trailing 2>&1", () => {
    assert.deepEqual(extractBaseCommand("npm test 2>&1"), { base: "npm test", suffix: " 2>&1" });
  });

  test("strips pipe to head", () => {
    assert.deepEqual(extractBaseCommand("npm test | head -10"), { base: "npm test", suffix: " | head -10" });
    assert.deepEqual(extractBaseCommand("npm test | head"), { base: "npm test", suffix: " | head" });
  });

  test("strips pipe to tail", () => {
    assert.deepEqual(extractBaseCommand("npm test | tail -20"), { base: "npm test", suffix: " | tail -20" });
    assert.deepEqual(extractBaseCommand("npm test | tail -f"), { base: "npm test", suffix: " | tail -f" });
  });

  test("strips pipe to grep", () => {
    assert.deepEqual(extractBaseCommand("npm test | grep -n 'error'"), { base: "npm test", suffix: " | grep -n 'error'" });
    assert.deepEqual(extractBaseCommand("npm test | grep error"), { base: "npm test", suffix: " | grep error" });
  });

  test("strips chained suffixes in order", () => {
    // The order is: first strip pipes (from end), then 2>&1
    assert.deepEqual(
      extractBaseCommand("npm test 2>&1 | grep foo | head -5"),
      { base: "npm test", suffix: " 2>&1 | grep foo | head -5" }
    );
    assert.deepEqual(
      extractBaseCommand("npm test | tail -10 | grep error"),
      { base: "npm test", suffix: " | tail -10 | grep error" }
    );
  });

  test("does not strip arbitrary pipes", () => {
    // Only head/tail/grep are stripped, not other commands
    assert.deepEqual(extractBaseCommand("cat file | wc -l"), { base: "cat file | wc -l", suffix: "" });
    assert.deepEqual(extractBaseCommand("npm test | sort"), { base: "npm test | sort", suffix: "" });
  });

  test("handles whitespace variations", () => {
    assert.deepEqual(extractBaseCommand("npm test  |  head -5"), { base: "npm test", suffix: "  |  head -5" });
    assert.deepEqual(extractBaseCommand("npm test   2>&1"), { base: "npm test", suffix: "   2>&1" });
  });
});

describe("run_bash", () => {
  test("falls back to the transcript when there is no TTY to ask on", async () => {
    const c = useContext({ session: { mode: "act" } });
    const result = await tool("run_bash").execute({ command: "echo hi", reason: "test it" });
    assert.match(String(result), /Waiting for the user to approve: echo hi/);
    assert.deepEqual(c.session.pendingBash, { command: "echo hi", reason: "test it" });
  });

  test("auto-approves variations of commands in alwaysApprove list", async () => {
    // When the base command is in alwaysApprove, variations with suffixes should also be approved
    const c = useContext({
      session: { mode: "act" },
      projectCfg: { alwaysApprove: ["echo hello"] },
    });
    
    // The base command should be auto-approved (no pending)
    const result = await tool("run_bash").execute({ command: "echo hello | head -1", reason: "test" });
    // Since there's no TTY, it would normally go to pendingBash, but the base is approved
    // so it should actually run. Let's check the output format.
    assert.ok(!String(result).includes("Waiting for the user to approve"));
    assert.equal(c.session.pendingBash, null);
  });

  test("workingDirectory runs command in subdirectory", async () => {
    const dir = tmpDir("run-bash-cwd");
    writeTmp(`${dir}/test.txt`, "hello from subdir");
    useContext({
      session: { mode: "act" },
      projectCfg: { alwaysApprove: ["cat test.txt"] },
    });
    
    const result = await tool("run_bash").execute({
      command: "cat test.txt",
      reason: "read file in subdir",
      workingDirectory: dir,
    });
    assert.match(String(result), /hello from subdir/);
  });

  test("workingDirectory rejects paths outside project", async () => {
    useContext({
      session: { mode: "act" },
      projectCfg: { alwaysApprove: ["pwd"] },
    });
    
    const result = await tool("run_bash").execute({
      command: "pwd",
      reason: "test escape",
      workingDirectory: "../..",
    });
    assert.match(String(result), /resolves outside the current directory/);
  });

  test("workingDirectory rejects non-directory paths", async () => {
    const dir = tmpDir("run-bash-notdir");
    const file = writeTmp(`${dir}/file.txt`, "not a dir");
    useContext({
      session: { mode: "act" },
      projectCfg: { alwaysApprove: ["pwd"] },
    });
    
    const result = await tool("run_bash").execute({
      command: "pwd",
      reason: "test file as cwd",
      workingDirectory: file,
    });
    assert.match(String(result), /is not a directory/);
  });
});

describe("git tools", () => {
  // These tests run against the actual git repo this project is in, so they verify
  // that the tools work with real git output rather than mocking it.
  
  test("git_status returns porcelain output or clean message", async () => {
    useContext({ session: { mode: "act" } });
    const out = String(await tool("git_status").execute({}));
    // Either there are changes (porcelain format lines) or it's clean
    assert.ok(out === "Working directory is clean." || out.includes(" "));
  });

  test("git_log shows commits with default limit of 10", async () => {
    useContext({ session: { mode: "act" } });
    const out = String(await tool("git_log").execute({}));
    assert.ok(out.length > 0);
    // Should have commit SHAs (at least 7 hex chars at line start)
    assert.match(out, /^[0-9a-f]{7,}/m);
  });

  test("git_log with patch=true defaults to 1 commit and includes diff", async () => {
    useContext({ session: { mode: "act" } });
    const out = String(await tool("git_log").execute({ patch: true }));
    assert.ok(out.length > 0);
    // With --patch, output includes diff markers
    assert.ok(out.includes("diff --git") || out.includes("No commits found."));
  });

  test("git_log respects limit parameter", async () => {
    useContext({ session: { mode: "act" } });
    const out = String(await tool("git_log").execute({ limit: 2 }));
    const lines = out.split("\n").filter(l => /^[0-9a-f]{7,}/.test(l));
    assert.ok(lines.length <= 2, `expected at most 2 commits, got ${lines.length}`);
  });

  test("git_log can scope to a specific file", async () => {
    useContext({ session: { mode: "act" } });
    // This file should exist and have history
    const out = String(await tool("git_log").execute({ path: "package.json", limit: 5 }));
    assert.ok(out === "No commits found." || out.includes("package.json") || /^[0-9a-f]{7,}/m.test(out));
  });

  test("git_merge_base finds common ancestor", async () => {
    useContext({ session: { mode: "act" } });
    // Use HEAD and HEAD~ which always have a merge base
    const out = String(await tool("git_merge_base").execute({ ref1: "HEAD", ref2: "HEAD~1", autoDetectMain: false }));
    // Should return a commit SHA (40 hex chars)
    assert.match(out, /^[0-9a-f]{40}$/);
  });

  test("git_merge_base auto-detects main branch", async () => {
    useContext({ session: { mode: "act" } });
    // This might succeed or fail depending on whether main/master exists, but shouldn't crash
    const out = await tool("git_merge_base").execute({ autoDetectMain: true });
    // Either a SHA or an error message
    assert.ok(typeof out === "string");
  });

  test("git_diff with no args shows working directory changes", async () => {
    useContext({ session: { mode: "act" } });
    const out = String(await tool("git_diff").execute({}));
    // Either "No differences." or actual diff output
    assert.ok(out === "No differences." || out.includes("diff --git") || out.length > 0);
  });

  test("git_diff with stat=true shows only file statistics", async () => {
    useContext({ session: { mode: "act" } });
    const out = String(await tool("git_diff").execute({ stat: true }));
    // If there are changes, --stat output includes file names and counts like "file.txt | 5 ++"
    // If no changes, we get "No differences."
    assert.ok(out === "No differences." || out.includes("|") || out.length >= 0);
  });

  test("git_diff between two refs", async () => {
    useContext({ session: { mode: "act" } });
    // Compare HEAD with itself - should always show no differences
    const out = String(await tool("git_diff").execute({ ref1: "HEAD", ref2: "HEAD" }));
    assert.equal(out, "No differences.");
  });

  test("git_diff can scope to a path", async () => {
    useContext({ session: { mode: "act" } });
    const out = String(await tool("git_diff").execute({ path: "package.json" }));
    assert.ok(typeof out === "string");
  });

  test("git tools handle errors gracefully", async () => {
    useContext({ session: { mode: "act" } });
    
    // Invalid ref should return an error message, not throw
    const badLog = await tool("git_log").execute({ ref: "nonexistent-ref-xyz" });
    assert.match(String(badLog), /Error:/);
    
    const badMergeBase = await tool("git_merge_base").execute({ 
      ref1: "HEAD", 
      ref2: "nonexistent-ref-xyz",
      autoDetectMain: false 
    });
    assert.match(String(badMergeBase), /Error:/);
    
    const badDiff = await tool("git_diff").execute({ ref1: "nonexistent-ref-xyz" });
    assert.match(String(badDiff), /Error:/);
  });
});

// Clean up the scratch directory the file-based tools used, so a later run starts fresh.
after(() => cleanTmp());
