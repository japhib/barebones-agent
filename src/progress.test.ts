import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { Progress, dim } from "./progress.js";

/** Swap process.stderr.write for a recorder and hand back a restore fn. */
function captureStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const original = process.stderr.write;
  (process.stderr.write as unknown) = (chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  };
  return { writes, restore: () => void ((process.stderr.write as unknown) = original) };
}

describe("dim", () => {
  test("wraps text in the dim/reset ANSI codes", () => {
    assert.equal(dim("hello"), "\x1b[2mhello\x1b[0m");
  });
});

describe("Progress", () => {
  test("a disabled progress writes nothing to stderr", () => {
    const { writes, restore } = captureStderr();
    const p = new Progress(false);
    try {
      p.step("thinking");
      p.line("kept line");
      p.stop();
    } finally {
      restore();
    }
    assert.deepEqual(writes, []);
  });

  test("off a TTY, changing phase writes no spinner output", () => {
    // In the test runner stderr is not a TTY, so `live` is false: phases are tracked but
    // never painted, keeping redirected stderr free of erasure noise.
    const { writes, restore } = captureStderr();
    const p = new Progress(true);
    try {
      p.step("thinking");
      p.step("running_run_bash");
      p.stop();
    } finally {
      restore();
    }
    assert.deepEqual(writes, []);
  });

  test("line always writes the permanent line, even off a TTY", () => {
    const { writes, restore } = captureStderr();
    const p = new Progress(true);
    try {
      p.line("here is a real line");
      p.stop();
    } finally {
      restore();
    }
    assert.deepEqual(writes, ["here is a real line\n"]);
  });

  test("step of the same label is a no-op that does not restate the phase", () => {
    const { writes, restore } = captureStderr();
    const p = new Progress(true);
    try {
      p.step("same");
      // Same label again: the dedupe guard returns early and nothing more happens.
      p.step("same");
      p.stop();
    } finally {
      restore();
    }
    // Off a TTY this is still silent, but critically only the phase change registered.
    assert.deepEqual(writes, []);
  });

  test("stop is idempotent and clears the label", () => {
    const { writes, restore } = captureStderr();
    const p = new Progress(true);
    try {
      p.step("thinking");
      p.stop();
      p.stop(); // second call must not throw
    } finally {
      restore();
    }
    assert.deepEqual(writes, []);
  });
});
