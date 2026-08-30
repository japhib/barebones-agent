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

/**
 * US dollars per million tokens.
 *
 * `cacheRead` and `cacheWrite` are optional because not every provider bills them:
 * Anthropic charges 2x input to write a 1h-TTL entry (the 5m rate would be 1.25x, but
 * this agent always writes with ttl:"1h") and 0.1x to read one, while DeepSeek caches
 * automatically, charges nothing to write, and bills a hit at a reduced input rate. A
 * missing rate falls back to `input`, which over-counts rather than quietly reporting
 * cached tokens as free.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Anthropic's published rates. Vertex serves the same models at the same list prices,
 *  so both namespaces are generated from this one table. */
const CLAUDE_PRICING: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 20 },
};

function namespaced(provider: string, table: Record<string, ModelPrice>): Record<string, ModelPrice> {
  return Object.fromEntries(Object.entries(table).map(([id, price]) => [`${provider}/${id}`, price]));
}

/**
 * Seeded from each provider's published rates, keyed "<provider>/<model>" so that two
 * providers serving a model of the same name keep separate prices. Prices change, and
 * the DeepSeek rates below are a seed rather than a promise — override per model in
 * config under "pricing" rather than editing this.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  ...namespaced("anthropic", CLAUDE_PRICING),
  ...namespaced("vertex", CLAUDE_PRICING),
  // No cacheWrite: DeepSeek populates its cache as a side effect of a normal request
  // and bills nothing for it, so there is no third category to report.
  "deepseek/deepseek-chat": { input: 0.28, output: 0.42, cacheRead: 0.028 },
  "deepseek/deepseek-reasoner": { input: 0.28, output: 0.42, cacheRead: 0.028 },
};

/**
 * The price for a model, tolerating every key form a config might use.
 *
 * A bare model id still works, which is what configs written before providers existed
 * contain. Vertex's "@version" suffix is stripped on the way through, so
 * `claude-sonnet-4-5@20250929` finds the `claude-sonnet-4-5` rate.
 */
export function priceFor(cfg: Config, provider: string, model: string): ModelPrice | undefined {
  const bare = model.split("@")[0] as string;
  return (
    cfg.pricing[`${provider}/${model}`] ??
    cfg.pricing[`${provider}/${bare}`] ??
    cfg.pricing[model] ??
    cfg.pricing[bare]
  );
}

export interface Config {
  /** A key of PROVIDERS in providers.ts: which API new sessions talk to. */
  provider: string;
  model: string;
  /** Model used to write compaction summaries. Null takes the provider's own default. */
  summaryModel: string | null;
  /** Vertex only. The project is required; the region defaults to us-east5. */
  vertexProject: string | null;
  vertexRegion: string;
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
 *
 * Providers that report fewer categories leave the rest at zero — DeepSeek's NodeLLM
 * client, for one, discards its cache-hit count, so every token there lands in `input`
 * and the turn is priced as if nothing was cached.
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
  /** Pinned per session, not read from config on resume: a session's history is full of
   *  one provider's tool-call ids and message shapes, and cannot move to another. */
  provider: string;
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
  /** Tool calls made during a turn the user interrupted, as display labels. Reported in
   *  the transcript on the way out and cleared once the model has been told. */
  interrupted: string[] | null;
  approvedOnce: string[];
}

/**
 * Ctrl-C state for the current turn.
 *
 * Two stages, because `ask()` is not streaming: while tools are running there is a safe
 * boundary every few seconds, but during a single model request there is none for as
 * long as the model takes to think. The first press waits for that boundary and loses
 * nothing; the second cuts the request itself.
 */
export interface Interrupt {
  requested: boolean;
  hard: boolean;
}

export interface Ctx {
  cfg: Config;
  session: Session;
  progress: Progress;
  interrupt: Interrupt;
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
  // A leading "~" is a home-directory reference on the shell, not a literal directory
  // name (path.resolve treats it literally and would quietly resolve "~/../etc" to
  // CWD/etc). Expand it first so the outside check below can judge it honestly: home is
  // never the current directory, so "~/..." is refused rather than silently contained.
  const expanded = p.replace(/^~(?=$|\/)/, os.homedir());
  const abs = path.resolve(CWD, expanded);
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
