/**
 * Fakes shared by the unit tests. Nothing the agent ships imports this — it exists so
 * each test file can get a valid Ctx without restating all eleven Session fields.
 */
import fs from "node:fs";
import path from "node:path";

import { Progress } from "./progress.js";
import { defaultModels } from "./providers.js";
import {
  CWD,
  DEFAULT_PRICING,
  setContext,
  zeroUsage,
  type Config,
  type Ctx,
  type Session,
} from "./context.js";

export function fakeConfig(over: Partial<Config> = {}): Config {
  return {
    provider: "anthropic",
    models: defaultModels(),
    summaryModel: null,
    vertexProject: null,
    vertexRegion: "us-east5",
    editor: [],
    renderer: "none",
    sessionDir: ".agent",
    compactAt: 0,
    alwaysApprove: [],
    tavilyApiKey: null,
    requestTimeoutMs: 1_000,
    bashTimeoutMs: 1_000,
    pricing: DEFAULT_PRICING,
    ...over,
  };
}

export function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: "testsess",
    provider: "anthropic",
    model: "claude-opus-5",
    mode: "act",
    announcedMode: null,
    messages: [],
    lastInputTokens: 0,
    usage: zeroUsage(),
    pendingQuestion: null,
    pendingBash: null,
    declinedCommand: null,
    interrupted: null,
    approvedOnce: [],
    ...over,
  };
}

/** Installs a fresh module-scope tool context and returns it, so a test can flip
 *  `mode` or `interrupt.requested` and have the tools see the change. Progress is
 *  silent unless a test passes its own: most assert on tool output, not narration. */
export function useContext(
  over: { cfg?: Partial<Config>; session?: Partial<Session>; progress?: Progress } = {},
): Ctx {
  const ctx: Ctx = {
    cfg: fakeConfig(over.cfg),
    session: fakeSession(over.session),
    progress: over.progress ?? new Progress(false),
    interrupt: { requested: false, hard: false },
  };
  setContext(ctx);
  return ctx;
}

/** Run `fn` with stderr captured, and return everything written to it. Progress writes
 *  there, so this is how a test reads what the user would have seen. */
export function captureStderr(fn: () => Promise<void>): Promise<string>;
export function captureStderr(fn: () => void): string;
export function captureStderr(fn: () => void | Promise<void>): string | Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  const restore = (): string => {
    process.stderr.write = original;
    return out;
  };
  try {
    const result = fn();
    // Restore inside the promise chain too, so an async caller does not lose stderr
    // for every other test that runs while this one is awaiting.
    if (result instanceof Promise) return result.then(restore, (err) => (restore(), Promise.reject(err)));
  } catch (err) {
    restore();
    throw err;
  }
  return restore();
}

/** The tools resolve every path against CWD, so scratch files have to live inside the
 *  project rather than in os.tmpdir(). Returns a CWD-relative path to hand to a tool. */
export const TMP_ROOT = "test-tmp";

export function tmpDir(name: string): string {
  const rel = path.join(TMP_ROOT, name);
  fs.rmSync(path.resolve(CWD, rel), { recursive: true, force: true });
  fs.mkdirSync(path.resolve(CWD, rel), { recursive: true });
  return rel;
}

export function writeTmp(rel: string, content: string): string {
  const abs = path.resolve(CWD, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return rel;
}

export function tmpExists(rel: string): boolean {
  return fs.existsSync(path.resolve(CWD, rel));
}

export function cleanTmp(): void {
  fs.rmSync(path.resolve(CWD, TMP_ROOT), { recursive: true, force: true });
}
