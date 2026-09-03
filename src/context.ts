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

/** How much of its work an editing tool shows. This is narration, not a document: a
 *  rewrite longer than this is better read in the file than scrolled past in the
 *  terminal. */
export const MAX_CHANGE_LINES = 200;

/** NodeLLM's own default is 30s, which a reasoning model exploring a real codebase
 *  blows through routinely. Both are overridable from config and the CLI. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/** The local LiteLLM proxy. No trailing slash: NodeLLM builds request URLs by string
 *  concatenation, so one would produce "/v1//chat/completions". */
export const DEFAULT_BASE_URL = "http://127.0.0.1:4000/v1";
/** A `model_name` from the proxy's model_list, not a provider's own model id. */
export const DEFAULT_MODEL = "deepseek";
/** NodeLLM refuses to build an OpenAI client without a key, even for a proxy that is
 *  not checking one, so a placeholder stands in when the env var is unset. */
export const PLACEHOLDER_API_KEY = "sk-litellm-local";

export const TREE_SKIP = new Set([".git", "node_modules", "dist", ".agent"]);

export type Mode = "plan" | "act";
export type Renderer = "auto" | "glow" | "bat" | "none";

export interface Config {
  /**
   * Which model to run, named as a `model_name` alias from the proxy's model_list.
   * Everything behind that alias — the real provider, its credentials, its region, its
   * cache settings — is the proxy's business and lives in its YAML, not here.
   */
  model: string;
  /** Where the proxy is listening. */
  baseUrl: string;
  /** Env var holding the proxy's key, if it is configured to want one. */
  apiKeyEnv: string;
  editor: string[];
  renderer: Renderer;
  sessionDir: string;
  requestTimeoutMs: number;
  bashTimeoutMs: number;
}

/** Per-project configuration, stored in .agent/project.json beside the sessions. */
export interface ProjectConfig {
  /** Custom file to read for project context instead of AGENTS.md / README.md. */
  contextFile?: string;
  /** Commands that never need approval for run_bash. */
  alwaysApprove: string[];
}

export interface PendingBash {
  command: string;
  reason: string;
}

/**
 * Tokens this session has moved. `input` is the whole prompt volume, cached or not —
 * which is what an OpenAI-shaped API reports natively, so it is taken as given rather
 * than reassembled from separate counters.
 */
export interface Usage {
  input: number;
  output: number;
  requests: number;
  turns: number;
}

export function zeroUsage(): Usage {
  return { input: 0, output: 0, requests: 0, turns: 0 };
}

export interface Session {
  id: string;
  model: string;
  mode: Mode;
  /** Mode is announced to the model only when it changes; re-announcing every turn
   *  would append a message each time and bloat the history for no benefit. */
  announcedMode: Mode | null;
  messages: Message[];
  usage: Usage;
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
  projectCfg: ProjectConfig;
  session: Session;
  progress: Progress;
  interrupt: Interrupt;
}

export function saveConfig(cfg: Config): void {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function saveProjectConfig(cfg: Config, projectCfg: ProjectConfig): void {
  const dir = path.resolve(CWD, cfg.sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), `${JSON.stringify(projectCfg, null, 2)}\n`);
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
