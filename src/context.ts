/**
 * Shared context: the types a session is built from, plus the two guards every tool
 * depends on. Kept in its own module so `tools.ts` and `agent.ts` can both import it
 * without a cycle.
 */
import os from "node:os";
import path from "node:path";
import type { Message } from "@node-llm/core";

export const APP_NAME = "barebones-agent";
export const APP_DIR = path.join(os.homedir(), `.${APP_NAME}`);
export const CONFIG_PATH = path.join(APP_DIR, "config.json");
export const CWD = process.cwd();

export const MAX_READ_LINES = 2000;
export const DEFAULT_TREE_DEPTH = 3;
export const MAX_TREE_DEPTH = 6;
export const MAX_TREE_ENTRIES = 500;
export const MAX_TOOL_OUTPUT = 60_000;
export const BASH_TIMEOUT_MS = 120_000;

export const TREE_SKIP = new Set([".git", "node_modules", "dist", ".agent"]);

export type Mode = "plan" | "act";
export type Renderer = "auto" | "glow" | "bat" | "none";

export interface Config {
  model: string;
  editor: string[];
  renderer: Renderer;
  sessionDir: string;
  compactAt: number;
  alwaysApprove: string[];
  tavilyApiKey: string | null;
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

export interface Session {
  id: string;
  model: string;
  mode: Mode;
  /** Mode is announced to the model only when it changes; re-announcing every turn
   *  would append a message each time and bloat the history for no benefit. */
  announcedMode: Mode | null;
  messages: Message[];
  lastInputTokens: number;
  pendingQuestion: PendingQuestion | null;
  pendingBash: PendingBash | null;
  approvedOnce: string[];
}

export interface Ctx {
  cfg: Config;
  session: Session;
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
  if (path.relative(CWD, abs).split(path.sep).includes(".git")) {
    throw new Error(`Refused: "${p}" is inside .git/.`);
  }
  return abs;
}
