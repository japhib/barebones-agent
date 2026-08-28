/**
 * Shared context: the types a session is built from, plus the two guards every tool
 * depends on. Kept in its own module so `tools.ts` and `agent.ts` can both import it
 * without a cycle.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@node-llm/core";

import type { Progress } from "./progress.js";

export const APP_NAME = "barebones-agent";
export const APP_DIR = path.join(os.homedir(), `.${APP_NAME}`);
export const CONFIG_PATH = path.join(APP_DIR, "config.json");
export const CWD = process.cwd();

export const MAX_READ_LINES = 2000;
export const DEFAULT_TREE_DEPTH = 3;
export const MAX_TREE_DEPTH = 6;
export const MAX_TREE_ENTRIES = 500;
export const MAX_TOOL_OUTPUT = 60_000;

/** NodeLLM's own default is 30s, which a reasoning model exploring a real codebase
 *  blows through routinely. Both are overridable from config and the CLI. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

export const TREE_SKIP = new Set([".git", "node_modules", "dist", ".agent"]);

export type Mode = "plan" | "act";
export type Renderer = "auto" | "glow" | "bat" | "none";

/** US dollars per million tokens. cacheWrite is the 1h-TTL rate (2x input); the 5m
 *  rate would be 1.25x, but this agent always writes with ttl:"1h". */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Seeded from Anthropic's published rates. Prices change; override per model in
 *  config under "pricing" rather than editing this. */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 20 },
};

export interface Config {
  model: string;
  editor: string[];
  renderer: Renderer;
  sessionDir: string;
  compactAt: number;
  alwaysApprove: string[];
  tavilyApiKey: string | null;
  requestTimeoutMs: number;
  bashTimeoutMs: number;
  pricing: Record<string, ModelPrice>;
}

export interface QuestionOption {
  label: string;
  description: string;
}
export interface PendingQuestion {
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}
export interface PendingBash {
  command: string;
  reason: string;
}

/**
 * Anthropic bills three kinds of input separately, so they are counted separately:
 * `input` is what was neither cached nor written (1x), `cacheRead` is served from cache
 * (0.1x), `cacheWrite` is what was stored into it (2x at the 1h TTL we use).
 */
export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  requests: number;
  turns: number;
  /** Accumulated in dollars, not tokens, so a mid-session model switch stays correct. */
  costUsd: number;
  /** True while every request counted so far had a known price. */
  priced: boolean;
}

export function zeroUsage(): Usage {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, turns: 0, costUsd: 0, priced: true };
}

export interface Session {
  id: string;
  model: string;
  mode: Mode;
  /** Mode is announced to the model only when it changes; re-announcing every turn
   *  would append a message each time and bloat the history for no benefit. */
  announcedMode: Mode | null;
  messages: Message[];
  lastInputTokens: number;
  usage: Usage;
  pendingQuestion: PendingQuestion | null;
  pendingBash: PendingBash | null;
  /** Set when the user declines interactively; the turn ends and they get the editor. */
  declinedCommand: string | null;
  approvedOnce: string[];
}

export interface Ctx {
  cfg: Config;
  session: Session;
  progress: Progress;
}

export function saveConfig(cfg: Config): void {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Tools are instantiated by NodeLLM from bare classes, so they cannot be handed
 *  dependencies through a constructor. Module scope is the pragmatic channel. */
let current: Ctx | null = null;

export function setContext(next: Ctx): void {
  current = next;
}

export function ctx(): Ctx {
  if (!current) throw new Error("tool context was never initialised");
  return current;
}

export function cap(s: string, limit = MAX_TOOL_OUTPUT): string {
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n\u2026 truncated ${s.length - limit} more characters.`;
}

/** Every path the agent touches goes through here. */
export function resolveSafe(p: string): string {
  const abs = path.resolve(CWD, p);
  if (abs !== CWD && !abs.startsWith(CWD + path.sep)) {
    throw new Error(`Refused: "${p}" resolves outside the current directory.`);
  }
  // .git is off limits, and so is the agent's own session directory: reading its
  // own transcript mid-turn wastes context and confuses the history it is building.
  const guarded = [".git", path.basename(current?.cfg.sessionDir ?? ".agent")];
  const hit = path.relative(CWD, abs).split(path.sep).find((seg) => guarded.includes(seg));
  if (hit) throw new Error(`Refused: "${p}" is inside ${hit}/.`);
  return abs;
}
