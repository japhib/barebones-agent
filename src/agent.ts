#!/usr/bin/env node
/**
 * barebones-agent — a coding agent that does one turn of work per process invocation.
 *
 * There is no input loop, instead it uses a code editor as a UI. Whenever the agent
 * needs a human — a follow-up prompt, an answer to a question, approval to run a
 * command — it records the request in the session transcript, saves state, and exits
 * with a hint for re-invoking.
 */
import { ModelRegistry, createLLM, type Message, type NodeLLMCore } from "@node-llm/core";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { repairDangling } from "./history.js";
import { Progress, dim } from "./progress.js";
import { extractBaseCommand, INTERRUPT_HALT, TOOLS } from "./tools.js";
import {
  APP_DIR,
  CONFIG_PATH,
  CWD,
  DEFAULT_BASE_URL,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_READ_LINES,
  PLACEHOLDER_API_KEY,
  saveConfig,
  saveProjectConfig,
  setContext,
  zeroUsage,
  type Config,
  type Interrupt,
  type Mode,
  type PendingBash,
  type ProjectConfig,
  type Renderer,
  type Session,
  type Usage,
} from "./context.js";

// ---------------------------------------------------------------- constants

const MAX_TOOL_CALLS = 100;
/** The launchd job that keeps the proxy alive; named in the error when it is not found to be running. */
const LAUNCH_AGENT = "com.barebones-agent.litellm";
const MAX_OUTPUT_TOKENS = 16_000;

/** GUI editors fork and return instantly; without a wait flag we would read the
 *  transcript back before the user has typed a single character. */
const GUI_EDITORS = new Set(["code", "code-insiders", "codium", "subl", "zed", "atom"]);

const YOU = "## You";
const PROMPT_STUB = "<!-- type your next prompt below, save, and re-run -->";
const INTERRUPT_STUB = "<!-- ask what it was doing, or tell it where to go next -->";
const ACT_STUB =
  "<!-- The agent is ready to build this. Write !act on its own line to switch to act\n     mode and proceed, or reply with changes you want first. -->";
/** The model emits this to say a plan is finished and it wants the go-ahead. */
const READY_MARKER = "<!-- !act -->";

const DEFAULT_CONFIG: Config = {
  model: DEFAULT_MODEL,
  baseUrl: DEFAULT_BASE_URL,
  apiKeyEnv: "LITELLM_MASTER_KEY",
  editor: [],
  renderer: "auto",
  sessionDir: ".agent",
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  bashTimeoutMs: DEFAULT_BASH_TIMEOUT_MS,
  stopHook: "",
};

// ---------------------------------------------------------------- helpers

/**
 * Thrown to exit main() cleanly. The top-level runner catches this, runs the stop hook,
 * and exits with the given code. This replaces scattered runStopHook + return patterns
 * with a single exit point.
 */
class AgentExit extends Error {
  constructor(
    public readonly code: number,
    public readonly message: string = "",
  ) {
    super(message);
  }
}

/**
 * Run the stop hook command if configured. Executed when the program exits to notify
 * the user (e.g., by playing a sound).
 */
function runStopHook(cfg: Config): void {
  const cmd = cfg.stopHook.trim();
  if (!cmd) return;
  try {
    // Run detached so we don't wait for it or capture output
    spawn("sh", ["-c", cmd], {
      stdio: "ignore",
      detached: true,
      timeout: 5000, // 5s max for the hook itself
    });
  } catch {
    // ignore it
  }
}

/** Exit with an error message. Throws AgentExit to unwind to the top-level handler. */
function die(msg: string): never {
  throw new AgentExit(1, msg);
}

function have(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

// ---------------------------------------------------------------- config

/**
 * A parsed config file laid over the defaults.
 *
 * Split out from the file handling so the layering rules — which keys merge, which
 * accept null, what happens to a key nobody recognises — can be exercised directly.
 * `warn` is a parameter for the same reason.
 */
export function mergeConfig(
  raw: Record<string, unknown>,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): Config {
  const cfg = { ...DEFAULT_CONFIG };
  for (const [k, v] of Object.entries(raw)) {
    // Warn rather than throw, so a stale key never bricks a run.
    if (!(k in DEFAULT_CONFIG)) {
      warn(`warning: unknown config key "${k}" in ${CONFIG_PATH}`);
      continue;
    }
    // null means "leave the default": no key carries it as a meaningful value.
    if (v !== null) (cfg as Record<string, unknown>)[k] = v;
  }
  return cfg;
}

function loadConfig(): Config {
  fs.mkdirSync(APP_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return mergeConfig({});
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch (err) {
    die(`Could not parse ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return mergeConfig(raw);
}

// ---------------------------------------------------------------- project config

const DEFAULT_PROJECT_CONFIG: ProjectConfig = { alwaysApprove: [] };

function projectConfigPath(cfg: Config): string {
  return path.join(sessionDir(cfg), "project.json");
}

/**
 * Load .agent/project.json if it exists, otherwise return defaults.
 * Does not create the file — it is optional and user-authored.
 */
export function loadProjectConfig(cfg: Config): ProjectConfig {
  const p = projectConfigPath(cfg);
  if (!fs.existsSync(p)) return { ...DEFAULT_PROJECT_CONFIG, alwaysApprove: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    const proj: ProjectConfig = { alwaysApprove: [] };
    if (typeof raw.contextFile === "string") proj.contextFile = raw.contextFile;
    if (Array.isArray(raw.alwaysApprove)) {
      proj.alwaysApprove = raw.alwaysApprove.filter((x): x is string => typeof x === "string");
    }
    // Warn about unknown keys, same as global config.
    for (const k of Object.keys(raw)) {
      if (k !== "contextFile" && k !== "alwaysApprove") {
        process.stderr.write(`warning: unknown project config key "${k}" in ${p}\n`);
      }
    }
    return proj;
  } catch (err) {
    die(`Could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function resolveEditor(cliEditor: string | undefined, cfg: Config): string[] {
  const raw = cliEditor
    ? cliEditor.split(/\s+/)
    : cfg.editor.length
      ? [...cfg.editor]
      : (process.env.VISUAL || process.env.EDITOR || "vi").split(/\s+/);
  const [cmd, ...args] = raw;
  if (!cmd) return ["vi"];
  if (GUI_EDITORS.has(path.basename(cmd)) && !args.some((a) => a === "-w" || a === "--wait")) {
    args.push("--wait");
  }
  return [cmd, ...args];
}

// ---------------------------------------------------------------- session

function sessionDir(cfg: Config): string {
  return path.resolve(CWD, cfg.sessionDir);
}
function jsonPath(cfg: Config, id: string): string {
  return path.join(sessionDir(cfg), `${id}.json`);
}
function mdPath(cfg: Config, id: string): string {
  return path.join(sessionDir(cfg), `${id}.md`);
}

/** Max characters to read from AGENTS.md / README.md for project context. */
const MAX_PROJECT_CONTEXT = 20_000;

/**
 * Read project context from the current directory.
 *
 * If `contextFile` is set (from project config), read only that file.
 * Returns the content wrapped in markers, or null if no file exists.
 */
export function readProjectContext(contextFile?: string): string | null {
  const candidates = contextFile ? [contextFile] : ["AGENTS.md", "CLAUDE.md", "README.md"];
  for (const name of candidates) {
    const p = path.join(CWD, name);
    if (!fs.existsSync(p)) continue;
    try {
      let content = fs.readFileSync(p, "utf8").trim();
      if (!content) continue;
      if (content.length > MAX_PROJECT_CONTEXT) {
        content = `${content.slice(0, MAX_PROJECT_CONTEXT)}\n\n[truncated ${content.length - MAX_PROJECT_CONTEXT} characters]`;
      }
      console.log(dim(`Reading project context file: ${name}`))
      return `[project context from ${name}]\n${content}\n[/project context]`;
    } catch {
      // Permission error, binary file, etc. — try next.
      continue;
    }
  }
  return null;
}

function newSession(model: string, mode: Mode): Session {
  return {
    id: randomUUID().slice(0, 8),
    model,
    mode,
    announcedMode: null,
    messages: [],
    usage: zeroUsage(),
    pendingBash: null,
    declinedCommand: null,
    interrupted: null,
    approvedOnce: [],
  };
}

function loadSession(cfg: Config, id: string): Session {
  const p = jsonPath(cfg, id);
  if (!fs.existsSync(p)) die(`No session "${id}" under ${sessionDir(cfg)}/`);
  const s = JSON.parse(fs.readFileSync(p, "utf8")) as Session;
  s.usage ??= zeroUsage(); // sessions created before usage tracking
  // Sessions written while input was counted in three parts. Folded into the single
  // total rather than dropped, so an old session's tokens are not silently lost.
  const legacy = s.usage as Usage & { cacheRead?: number; cacheWrite?: number };
  s.usage.input += (legacy.cacheRead ?? 0) + (legacy.cacheWrite ?? 0);
  delete legacy.cacheRead;
  delete legacy.cacheWrite;
  s.declinedCommand ??= null;
  s.interrupted ??= null;
  // Repaired on the way in as well as on the way out, so a session already poisoned by
  // an older build — or by a crash between the two — still resumes.
  s.messages = repairDangling(s.messages ?? []);
  return s;
}

/** The opening prompt, as a one-line label for a session. Read from the transcript
 *  rather than the history, which starts with the mode announcement. */
export function sessionTitle(cfg: Config, s: Session): string {
  let text = "";
  const p = mdPath(cfg, s.id);
  if (fs.existsSync(p)) {
    const md = fs.readFileSync(p, "utf8");
    const i = md.indexOf(`\n${YOU}\n`);
    if (i !== -1) {
      text = md.slice(i + YOU.length + 2).replace(/<!--[\s\S]*?-->/g, "");
      const end = text.indexOf("\n## ");
      if (end !== -1) text = text.slice(0, end);
    }
  }
  if (!text.trim()) {
    const first = s.messages?.find(
      (m) => m.role === "user" && !String(m.content ?? "").startsWith("[mode:"),
    );
    text = String(first?.content ?? "");
  }
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "(no prompt yet)";
  return line.length > 72 ? `${line.slice(0, 71)}\u2026` : line;
}

export function ago(ms: number): string {
  const secs = Math.max(0, (Date.now() - ms) / 1000);
  if (secs < 60) return `${Math.round(secs)}s ago`;
  if (secs < 3_600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3_600)}h ago`;
  return `${Math.round(secs / 86_400)}d ago`;
}

/**
 * Find the most recently modified session in this directory.
 * Returns the session ID, or null if no sessions exist.
 */
export function getMostRecentSessionId(cfg: Config): string | null {
  const dir = sessionDir(cfg);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

  let newest: { id: string; mtimeMs: number } | null = null;
  for (const file of files) {
    const p = path.join(dir, file);
    try {
      const stat = fs.statSync(p);
      const id = path.basename(file, ".json");
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { id, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // Skip unreadable files
    }
  }
  return newest?.id ?? null;
}

/**
 * Every session saved under this directory, newest first, each with the command that
 * resumes it. Sessions live beside the project (cfg.sessionDir), so this is inherently
 * scoped to the current directory — there is no global list to filter.
 */
export function listSessions(cfg: Config): void {
  const dir = sessionDir(cfg);
  const rel = path.relative(CWD, dir) || dir;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

  const found: { s: Session; mtimeMs: number }[] = [];
  for (const file of files) {
    const p = path.join(dir, file);
    try {
      const s = JSON.parse(fs.readFileSync(p, "utf8")) as Session;
      s.id ||= path.basename(file, ".json");
      s.usage ??= zeroUsage();
      found.push({ s, mtimeMs: fs.statSync(p).mtimeMs });
    } catch {
      process.stderr.write(dim(`skipped unreadable session file ${rel}/${file}`) + "\n");
    }
  }

  if (!found.length) {
    process.stdout.write(`No sessions under ${rel}/.\n`);
    return;
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  process.stdout.write(`${found.length} session${found.length === 1 ? "" : "s"} under ${rel}/\n`);
  for (const { s, mtimeMs } of found) {
    // A halted session resumes through the flag that unblocks it, not through -e.
    const waiting = s.pendingBash
      ? "  \u26a0 awaiting approval"
      : s.interrupted
        ? "  \u23f8 interrupted"
        : "";
    const next = s.pendingBash ? "--approve" : "-e";
    const meta = `${ago(mtimeMs)} \u00b7 ${s.mode} \u00b7 ${s.model} \u00b7 ${s.usage.turns} turn${s.usage.turns === 1 ? "" : "s"}`;
    process.stdout.write(
      `\n  ${s.id}  ${dim(meta)}${waiting}\n` +
        `  ${dim(sessionTitle(cfg, s))}\n` +
        `  \u21bb  ${invocation()} -s ${s.id} ${next}\n`,
    );
  }
}

/** `usage` and `reasoning` vary every turn. Re-sending them would perturb the
 *  serialized request and cost us the prompt cache, so they never get persisted.
 *  System messages are dropped too: withInstructions() re-applies the prompt on every
 *  run, so persisting it would stack one more copy per turn.
 *
 *  Every path that persists a turn goes through here, so this is also where a history
 *  left dangling by an interrupt, a timeout or a blown maxToolCalls is repaired. */
export function slim(messages: readonly Message[]): Message[] {
  return repairDangling(messages)
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => {
      const { usage: _u, reasoning: _r, ...rest } = m;
      return { ...rest, content: m.content == null ? null : String(m.content) } as Message;
    });
}

function saveSession(cfg: Config, s: Session): void {
  fs.mkdirSync(sessionDir(cfg), { recursive: true });
  fs.writeFileSync(jsonPath(cfg, s.id), `${JSON.stringify(s, null, 2)}\n`);
}

// ---------------------------------------------------------------- transcript

function appendTranscript(cfg: Config, s: Session, text: string): void {
  fs.mkdirSync(sessionDir(cfg), { recursive: true });
  const p = mdPath(cfg, s.id);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, `# session ${s.id}  ·  mode: ${s.mode}  ·  ${s.model}\n`);
  }
  fs.appendFileSync(p, text);
}

/** The prompt is everything after the final "## You" heading. */
export function readPromptFromTranscript(cfg: Config, s: Session): string {
  const p = mdPath(cfg, s.id);
  if (!fs.existsSync(p)) return "";
  const text = fs.readFileSync(p, "utf8");
  const i = text.lastIndexOf(`\n${YOU}\n`);
  if (i === -1) return "";
  return text
    .slice(i + YOU.length + 2)
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

function ensurePromptStub(cfg: Config, s: Session): void {
  const p = mdPath(cfg, s.id);
  const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (!text.includes(`\n${YOU}\n`) || readPromptFromTranscript(cfg, s) !== "") {
    appendTranscript(cfg, s, `\n${YOU}\n\n${PROMPT_STUB}\n`);
  }
}

export function renderApproval(b: PendingBash, s: Session): string {
  const run = `${invocation()} -s ${s.id}`;
  return [
    `\n## ⚠️  Approval required\n`,
    `The agent wants to run:\n`,
    "```sh",
    b.command,
    "```\n",
    `**Why:** ${b.reason}\n`,
    "```",
    `${run} --approve          run it once`,
    `${run} --always-approve   run it, and never ask for this command again`,
    `${run} --decline          refuse, and tell it what to do instead`,
    "```\n",
  ].join("\n");
}

/**
 * What the interrupted turn actually did.
 *
 * Progress narration goes to stderr and erases itself on a TTY, so by the time the user
 * opens the transcript it is gone. This list is the only durable record of the calls
 * they stopped to ask about.
 */
export function renderInterrupted(calls: string[], forced: boolean): string {
  const what = calls.length
    ? `_Stopped after ${calls.length} tool call${calls.length === 1 ? "" : "s"}._\n`
    : `_Stopped before it made any tool calls._\n`;
  const lines = [`\n## \u23f8 Interrupted\n`, what];
  if (calls.length) lines.push(`${calls.map((c) => `- \`${c}\``).join("\n")}\n`);
  if (forced) {
    lines.push(
      `_The reply in flight was discarded, so its tokens are billed but not counted._\n`,
    );
  }
  lines.push(`\n${YOU}\n\n${INTERRUPT_STUB}\n`);
  return lines.join("\n");
}

/** Delivered as a trailing user message, the way modeMessage announces a mode change.
 *  It lands after the cached prefix, so unlike editing SYSTEM_PROMPT it costs no hit. */
export function interruptedMessage(n: number): string {
  return (
    `[interrupted] The user pressed Ctrl-C and stopped you after ${n} tool call${n === 1 ? "" : "s"}. ` +
    `The tool results above are real; any marked as never run did not run. Their next ` +
    `message responds to that interruption and is most likely a question about what you ` +
    `were doing. Answer it from what you already found, then stop. Do not resume the ` +
    `interrupted task unless they ask you to.`
  );
}

// ---------------------------------------------------------------- tools

// ---------------------------------------------------------------- prompt

// SYSTEM_PROMPT is in the cached prefix of input to the model, so anything
// volatile here (a date, the cwd, the mode) would cost a cache hit every turn.
const SYSTEM_PROMPT = `You are a coding agent working inside a single project directory.

You work in one turn per invocation. There is no interactive prompt: when you need
clarification or input from the user, just stop and explain what you need. Your turn will
end and they can respond in the next invocation.

Tools:
- list_tree, read_file, search_code, and the git_* tools run immediately and cost the user
  nothing. Use them freely, and prefer them over guessing.
- write_file, edit_file and delete_file modify the project. They are refused while the
  session is in plan mode.
- run_bash ALWAYS stops the session and asks the user to approve the command before it
  runs. That costs them a round trip, so reach for it only when no other tool can do the
  job: running tests, package managers, build steps. Never use it to read, search
  or list files — use the read-only tools instead, including git_* tools for repository
  information.

When several tool calls do not depend on each other — three files to read, a read and a
search, two directories to list — make them all in one message rather than one per turn.
They run together and every result comes back at once. Only let a call wait when it
genuinely needs an earlier result to decide its arguments. Every extra message is
another round trip to the model, so reading six files one at a time is five round trips
slower than reading them together.

Every path you touch must be inside the current directory.

Begin by analyzing the user's input and gathering any necessary additional context.
Orient yourself with list_tree or search_code rather than assuming a layout.
Read a file before you edit it. When you change code, match the surrounding style.

When you are in plan mode and the plan is finished and you want the user to go ahead,
end your response with exactly this line and nothing after it:

<!-- !act -->

That turns the reply the user is about to write into a prompt telling them they can type
!act to switch to act mode. Only use it when the plan genuinely needs no more input.

Remember:
- Always adhere to existing code conventions and patterns.
- Use only libraries and frameworks that are confirmed to be in use in the current codebase.
- Provide complete and functional code without omissions or placeholders.
- Be explicit about any assumptions or limitations in your solution.
- Always show your planning process before executing any task. This will help ensure that you have a clear understanding of the requirements and that your approach aligns with the user's needs.
- Always use absolute paths when referring to files.
- You can call multiple tools in a single response. Before using tools, identify every independent read, search, command, or edit needed for the next step and emit all of those tool calls now, either as multiple tool calls or as one batched input for tools that accept arrays. Do not wait for one independent result before requesting another. Do not split independent reads, searches, checks, or edits across separate turns.
- Good parallelism examples: read all known relevant files in one read_files call; emit independent read_file, search_code, and run_bash calls together in one response; emit multiple editor calls together when editing different files or non-overlapping regions.
- Always verify the files you have edited or created at the end of the task to ensure they are completed and working as expected.
- For every code change made, add automated tests (or update existing ones) to document new or changed behavior.
- If you're fixing a bug, add a regression test.
- Do not be overly verbose with code comments. Focus on a concise 'why' the code is doing what it's doing, not 'what' it's doing (unless it's complicated enough that a competent software engineer would have trouble understanding what's happening without additional comments.)

Write your final answer as Markdown. Be concise and concrete: reference files as
path:line, show only the code that matters, and say plainly what you did and what you
did not do.
`;

export function modeMessage(mode: Mode): string {
  return mode === "plan"
    ? "[mode: plan] Investigate and produce a plan. Do not modify anything — the editing tools will refuse to run."
    : "[mode: act] You may modify files. Carry out the task.";
}

// ---------------------------------------------------------------- output

/**
 * What this turn moved, summed over every request the tool loop made.
 *
 * NodeLLM hangs `usage` on each assistant message it appends, and we strip that field
 * before persisting — so whatever carries usage in history right now is exactly this
 * turn. (chat.totalUsage would be simpler but silently omits some counters.)
 *
 * `input_tokens` is taken as the whole prompt volume and nothing is added to it. That is
 * the OpenAI shape the proxy speaks: `prompt_tokens` already includes anything served
 * from cache, and `cached_tokens` is a subset of it rather than a separate bucket.
 * Adding the two — which is what the direct Anthropic API needed, since it reports the
 * uncached remainder — would count every cached token twice.
 */
export function turnUsage(history: readonly Message[]): Usage {
  const u = zeroUsage();
  for (const m of history) {
    const x = m.usage;
    if (!x) continue;
    u.input += x.input_tokens ?? 0;
    u.output += x.output_tokens ?? 0;
    u.requests += 1;
  }
  u.turns = 1;
  return u;
}

export function addUsage(total: Usage, next: Usage): Usage {
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    requests: total.requests + next.requests,
    turns: total.turns + next.turns,
  };
}

const n = (x: number): string => x.toLocaleString("en-US");

export function formatUsage(label: string, u: Usage): string {
  const requests = `${n(u.requests)} request${u.requests === 1 ? "" : "s"}`;
  return `${label.padEnd(8)} in ${n(u.input)}  out ${n(u.output)}  \u00b7  ${requests}`;
}

/**
 * What a finished turn moved, for the footer.
 *
 * Printed on every run rather than behind --verbose: what a turn cost in tokens is the
 * main thing worth knowing once the answer is read, and a flag you have to remember to
 * pass is a flag you find out you needed afterwards. --verbose adds the session total
 * on top. stderr, like the rest of the narration, so a piped stdout stays the answer
 * alone; --quiet drops it with everything else.
 */
function reportUsage(spent: Usage, session: Session, opts: { quiet?: boolean; verbose?: boolean }): void {
  if (opts.quiet) return;
  const lines = [formatUsage("turn", spent)];
  if (opts.verbose) lines.push(formatUsage("session", session.usage));
  process.stderr.write(`\n${lines.map(dim).join("\n")}\n`);
}

/**
 * The model's own commentary since `from`, as lines to narrate.
 *
 * `from` matters: a resumed session hands `chat` its entire history before the turn
 * starts, so a scan that always began at zero would replay every answer the session
 * has ever given the moment the first tool call fired. Opening at the restored length
 * means only what the model writes during *this* turn is new. `next` is the high-water
 * mark to pass back in.
 */
export function newNarration(
  history: readonly Message[],
  from: number,
): { lines: string[]; next: number } {
  const lines: string[] = [];
  for (let i = Math.max(0, from); i < history.length; i++) {
    const m = history[i];
    if (m?.role !== "assistant") continue;
    const text = String(m.content ?? "").trim();
    // Only the opening lines: a long answer belongs in the transcript, not the spinner.
    if (text) lines.push(text.split("\n").slice(0, 4).join("\n"));
  }
  return { lines, next: history.length };
}

/**
 * A line that is exactly `!act` or `!plan` switches the session mode and is removed
 * from the prompt. On its own it means "proceed", so the plan just written becomes the
 * instruction rather than making the user restate it.
 */
export function extractMode(prompt: string): { prompt: string; mode: Mode | null } {
  const lines = prompt.split("\n");
  let mode: Mode | null = null;
  const kept = lines.filter((line) => {
    const directive = line.trim();
    if (directive === "!act") return (mode = "act"), false;
    if (directive === "!plan") return (mode = "plan"), false;
    return true;
  });
  const rest = kept.join("\n").trim();
  if (!mode) return { prompt: rest, mode: null };
  const implied = mode === "act" ? "Proceed with the plan." : "Re-examine this and produce a plan.";
  return { prompt: rest || implied, mode };
}

/**
 * Teach the registry about the model id before it is used.
 *
 * Model ids here are proxy aliases — "deepseek", "vertex-claude" — which NodeLLM's
 * bundled registry has never heard of. An unknown id fails its tool-support check
 * outright, with "Model X does not support tool calling", so without this the agent
 * would not run at all. (`assumeModelExists` skips the check but only downgrades it to
 * a warning logged every run, and leaves max_output_tokens at the OpenAI default.)
 *
 * Saved unconditionally rather than behind a `find()` miss: `find` falls back to a
 * bidirectional prefix match, so an alias could quietly resolve to some unrelated
 * bundled entry and inherit its limits. Writing our own entry every time is both
 * cheaper than the lookup and immune to that.
 */
export function ensureModelKnown(session: Session): void {
  ModelRegistry.save({
    id: session.model,
    name: session.model,
    provider: "openai",
    family: "proxy",
    // What sits behind the alias is the proxy's business, so these are the ceilings of
    // a current frontier model rather than anything this repo can know.
    context_window: 1_000_000,
    max_output_tokens: 128_000,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    capabilities: ["streaming", "reasoning", "chat", "vision", "function_calling", "tools", "structured_output", "json_mode"],
  });
}

/** Tool inputs arrive as a JSON string; parse it, never string-match it. */
export function describeCall(call: unknown): { name: string; args: string } {
  const c = call as { function?: { name?: string; arguments?: string } };
  const name = c.function?.name ?? "tool";
  try {
    const a = JSON.parse(c.function?.arguments ?? "{}") as Record<string, unknown>;
    const key = a.path ?? a.pattern ?? a.query ?? a.command ?? a.question;
    if (key === undefined) return { name, args: "" };
    const args = String(key).slice(0, 80);
    return { name, args: name === "read_file" ? args + readRange(a) : args };
  } catch {
    return { name, args: "" };
  }
}

/** " lines 40-120" for a read_file call, mirroring the slice the tool will take.
 *  A read with neither bound is the whole file, and saying "lines 1-2000" about a
 *  40-line file would be a lie, so that case gets no suffix. */
export function readRange(a: Record<string, unknown>): string {
  const offset = typeof a.offset === "number" ? a.offset : undefined;
  const limit = typeof a.limit === "number" ? a.limit : undefined;
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  if (limit === undefined) return ` lines ${start}-`;
  return ` lines ${start}-${start + Math.min(limit, MAX_READ_LINES) - 1}`;
}

/** Check if an error is a connection failure that should be retried. */
function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|fetch failed/i.test(msg);
}

/** Sleep for the specified number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff for connection errors.
 * Retries at 500ms, 1s, and 2s intervals before giving up.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  progress: Progress,
): Promise<T> {
  const delays = [500, 1000, 2000];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      
      // Don't retry non-connection errors
      if (!isConnectionError(err)) throw err;
      
      // Don't retry if we're out of attempts
      if (attempt >= delays.length) throw err;
      
      const delayMs = delays[attempt];
      progress.line(dim(`LiteLLM slow to respond, retrying in ${delayMs}ms...`));
      await sleep(delayMs);
    }
  }

  // TypeScript doesn't know we always throw in the loop above
  throw lastError;
}

/** A bare "Request timeout after 30000ms" tells the user nothing about what stalled. */
export function explainFailure(err: unknown, cfg: Config): string {
  const msg = err instanceof Error ? err.message : String(err);
  // fetchWithTimeout rethrows a raw AbortError when something other than its own timeout
  // controller fired — which, here, is always the user cutting the request.
  if (err instanceof Error && err.name === "AbortError") return "The request was cut short.";
  // With everything behind one local proxy, "nothing is listening" is the failure the
  // user will hit most, and a bare ECONNREFUSED says nothing about how to fix it.
  if (isConnectionError(err)) {
    return (
      `Could not reach the LiteLLM proxy at ${cfg.baseUrl}. Start it with:\n` +
      `  launchctl kickstart -k gui/$(id -u)/${LAUNCH_AGENT}\n` +
      `and check ${path.join(APP_DIR, "litellm.log")} if it does not come up.`
    );
  }
  const timeout = /^Request timeout after (\d+)ms$/.exec(msg);
  if (timeout) {
    const secs = Math.round(Number(timeout[1]) / 1000);
    return (
      `The model API request timed out after ${secs}s. This is the LLM call itself, ` +
      `not a tool — tools report their own timeouts by name. ` +
      `Retry with --timeout <seconds>, or raise "requestTimeoutMs" in ${CONFIG_PATH} ` +
      `(currently ${Math.round(cfg.requestTimeoutMs / 1000)}s).`
    );
  }
  return msg;
}

function invocation(): string {
  return 'bba';
  // const argv1 = process.argv[1] ?? "";
  // if (path.basename(argv1) === "bba") return "bba";
  // const rel = path.relative(CWD, argv1);
  // // Relative only while it stays inside the project; otherwise it is a wall of "../".
  // return `node ${rel && !rel.startsWith("..") ? rel : argv1}`;
}

function render(md: string, cfg: Config): void {
  let pick: Renderer = cfg.renderer;
  if (pick === "auto") {
    pick = have("glow") ? "glow" : have("bat") ? "bat" : "none";
    // Only worth saying when someone is actually reading the terminal; a piped or
    // redirected stdout wanted the plain Markdown anyway.
    if (pick === "none" && process.stdout.isTTY) {
      process.stderr.write(
        dim("Neither glow nor bat found — printing plain Markdown. `brew install glow`, or set \"renderer\" in the config to silence this.") + "\n",
      );
    }
  }
  if (pick !== "none") {
    const args = pick === "glow" ? ["-"] : ["-l", "md", "--style=plain"];
    const r = spawnSync(pick, args, { input: md, stdio: ["pipe", "inherit", "inherit"] });
    if (!r.error && r.status === 0) return;
  }
  process.stdout.write(`${md}\n`);
}

// ---------------------------------------------------------------- main

const HELP = `barebones-agent — one turn of work per invocation.

  bba "prompt"                    start a new session
  bba -e                          start one, writing the prompt in your editor
  bba -f prompt.md                start one from a prompt file
  bba -s <id> "prompt"            continue a session
  bba -s <id> -f prompt.md        take the prompt from a file
  bba -s <id> -e                  edit the transcript, then run what you wrote
  bba -s <id>                     run whatever is under the last "## You"
  bba -c | --continue             continue the most recent session
  bba -l | --sessions             list this directory's sessions and how to resume each

  --plan / -p | --act / -a        switch mode (persists in the session). Default: act mode
  -m / --model <alias>            a model_name from the proxy's model_list
  --approve | --always-approve    allow the pending shell command
  --decline [reason]              refuse it; with no reason, hands back to you
  --timeout <s>                   per-request limit for the model API
  --bash-timeout <s>              limit for a single run_bash command
  --quiet                         no progress output (including the token line)
  --usage                         report this session's token usage and exit

  Ctrl-C stops the turn and saves it; press it twice to cut a request in flight.
  Write !act or !plan on its own line in the transcript to switch mode.
  --editor <cmd>  --verbose  --help

Config: ${CONFIG_PATH}`;

async function main(cfg: Config): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      session: { type: "string", short: "s" },
      continue: { type: "boolean", short: "c" },
      file: { type: "string", short: "f" },
      edit: { type: "boolean", short: "e" },
      plan: { type: "boolean", short: "p" },
      act: { type: "boolean", short: "a" },
      approve: { type: "boolean" },
      "always-approve": { type: "boolean" },
      decline: { type: "boolean" },
      model: { type: "string", short: "m" },
      editor: { type: "string" },
      timeout: { type: "string" },
      "bash-timeout": { type: "string" },
      quiet: { type: "boolean", short: "q" },
      usage: { type: "boolean" },
      sessions: { type: "boolean", short: "l" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (values.timeout) cfg.requestTimeoutMs = Number(values.timeout) * 1000;
  if (values["bash-timeout"]) cfg.bashTimeoutMs = Number(values["bash-timeout"]) * 1000;

  if (values.sessions) {
    // Read-only, and never needs an id: this is how you find one.
    listSessions(cfg);
    return;
  }

  // Handle -c/--continue: find the most recent session
  let sessionId = values.session;
  if (values.continue) {
    if (values.session) die("Cannot use both -c/--continue and -s/--session.");
    const recentId = getMostRecentSessionId(cfg);
    if (!recentId) die(`No sessions to continue under ${sessionDir(cfg)}/. Start one with:\n  ${invocation()} "prompt"`);
    sessionId = recentId;
  }

  const mode: Mode = values.plan ? "plan" : values.act ? "act" : "act";
  const model = values.model || cfg.model;
  const isNewSession = !sessionId;
  const session = isNewSession ? newSession(model, mode) : loadSession(cfg, sessionId);
  const projectCfg = loadProjectConfig(cfg);
  // Inject project context at the start of new sessions.
  // Uses contextFile from project config if set, else AGENTS.md / CLAUDE.md / README.md.
  // Also includes pre-approved commands so the LLM knows to prefer them.
  if (isNewSession) {
    const parts: string[] = [];
    const projectContext = readProjectContext(projectCfg.contextFile);
    if (projectContext) parts.push(projectContext);
    
    // Tell the LLM about pre-approved commands (part of cached prefix, not updated later)
    if (projectCfg.alwaysApprove.length > 0) {
      parts.push(
        `[pre-approved run_bash commands]\n` +
        `The following commands are already approved and will run without asking:\n` +
        projectCfg.alwaysApprove.map(cmd => `  ${cmd}`).join("\n") + "\n" +
        `Prefer these when you need shell access. You may add | head, | tail, | grep, or 2>&1 to any of them.\n` +
        `[/pre-approved run_bash commands]`
      );
    }
    
    if (parts.length) {
      session.messages.push({ role: "user", content: parts.join("\n\n") });
    }
  }
  if (values.model) session.model = values.model;
  if (values.plan) session.mode = "plan";
  if (values.act) session.mode = "act";
  const progress = new Progress(!values.quiet);
  const interrupt: Interrupt = { requested: false, hard: false };
  setContext({ cfg, projectCfg, session, progress, interrupt });

  const resume = `${invocation()} -s ${session.id}`;

  if (values.usage) {
    // Read-only: report what the session has used without calling the model.
    process.stdout.write(`${formatUsage("session", session.usage)}\n`);
    process.stdout.write(
      `         across ${session.usage.turns} turn${session.usage.turns === 1 ? "" : "s"} · ${session.mode} mode · ${session.model}\n`,
    );
    return;
  }
  let prompt = "";

  // --- resolve where this turn's prompt comes from -------------------------
  const pending = session.pendingBash;
  if (values.approve || values["always-approve"]) {
    if (!pending) die(`Nothing is awaiting approval in session ${session.id}.`);
    // Extract base command for approval — variations with pipes/redirects are also approved
    const { base: baseCmd } = extractBaseCommand(pending.command);
    if (values["always-approve"]) {
      if (!projectCfg.alwaysApprove.includes(baseCmd)) {
        projectCfg.alwaysApprove.push(baseCmd);
      }
      saveProjectConfig(cfg, projectCfg);
    } else {
      session.approvedOnce.push(baseCmd);
    }
    session.pendingBash = null;
    prompt = `Approved. Run \`${pending.command}\` and continue.`;
    appendTranscript(cfg, session, `\n**Approved:** \`${pending.command}\`\n`);
  } else if (values.decline) {
    if (!pending) die(`Nothing is awaiting approval in session ${session.id}.`);
    session.pendingBash = null;
    const reason = positionals.join(" ").trim();
    appendTranscript(cfg, session, `\n**Declined:** \`${pending.command}\`\n`);
    const note = `The user declined to run \`${pending.command}\`. Do not try to run it again.`;
    if (!reason) {
      // No guidance given, so hand control back rather than letting it guess.
      appendTranscript(cfg, session, `\n${YOU}\n\n<!-- tell the agent what to do instead -->\n`);
      saveSession(cfg, session);
      process.stdout.write(`Declined \`${pending.command}\`.\n\n↻  ${resume} -e\n`);
      return;
    }
    prompt = `${note} ${reason}`;
  } else if (positionals.length) {
    prompt = positionals.join(" ");
  } else if (values.file) {
    prompt = fs.readFileSync(values.file, "utf8").trim();
  }

  if (prompt) appendTranscript(cfg, session, `\n${YOU}\n\n${prompt}\n`);

  // If no prompt provided via CLI or file, default to edit mode
  const shouldEdit = values.edit || (!prompt && !positionals.length && !values.file);

  if (!prompt && shouldEdit) {
    ensurePromptStub(cfg, session);
    const [cmd, ...args] = resolveEditor(values.editor, cfg);
    console.log(dim('Opening editor for user input ...'));
    const r = spawnSync(cmd as string, [...args, mdPath(cfg, session.id)], { stdio: "inherit" });
    if (r.error) die(`Could not launch editor "${cmd}": ${r.error.message}`);
  }

  if (!prompt) prompt = readPromptFromTranscript(cfg, session);

  if (!prompt) {
    // If this is a new session with no prompt, show help instead of creating empty session
    if (isNewSession) {
      // Clean up any files created by ensurePromptStub when opening editor
      const transcriptPath = mdPath(cfg, session.id);
      if (fs.existsSync(transcriptPath)) {
        fs.unlinkSync(transcriptPath);
      }
      process.stdout.write(`${HELP}\n`);
      return;
    }
    // For existing sessions, keep the original behavior
    ensurePromptStub(cfg, session);
    saveSession(cfg, session);
    die(`No prompt found. Write one under the last "## You" heading:\n\n↻  ${resume} -e`);
  }
  // A directive written into the prompt wins over the flags: it is the newer intent.
  const directive = extractMode(prompt);
  prompt = directive.prompt;
  if (directive.mode) session.mode = directive.mode;

  if (!values.quiet) {
    const switched = directive.mode || values.plan || values.act ? "  (switched)" : "";
    process.stderr.write(dim(`${session.mode} mode · ${session.model} · session ${session.id}${switched}`) + "\n");
  }

  // --- run ----------------------------------------------------------------
  ensureModelKnown(session);
  // One endpoint for every model: the proxy decides which upstream an alias reaches, so
  // there is nothing provider-shaped left to choose here. Typed rather than inferred —
  // an evolving `any` would silently un-check the whole chat chain built from it.
  //
  // `openaiApiKey` has to be non-empty even against a proxy that is not checking one,
  // because NodeLLM refuses to construct the client otherwise.
  const llm: NodeLLMCore = createLLM({
    provider: "openai",
    openaiApiKey: process.env[cfg.apiKeyEnv] || PLACEHOLDER_API_KEY,
    openaiApiBase: cfg.baseUrl,
  });
  const chat = llm
    .chat(session.model, {
      maxTokens: MAX_OUTPUT_TOKENS,
      // The default agentic loop cap is 5 rounds, which a real coding task blows
      // through immediately. (withToolCalls() is a different knob — parallelism.)
      maxToolCalls: MAX_TOOL_CALLS,
      requestTimeout: cfg.requestTimeoutMs,
    })
    .withInstructions(SYSTEM_PROMPT);

  if (session.messages.length) chat.addMessages(session.messages);
  if (session.announcedMode !== session.mode) {
    chat.addMessage({ role: "user", content: modeMessage(session.mode) });
    session.announcedMode = session.mode;
  }
  if (session.interrupted) {
    chat.addMessage({ role: "user", content: interruptedMessage(session.interrupted.length) });
    session.interrupted = null;
  }

  chat.withTools(TOOLS);

  // Progress. By the time onToolCallStart fires, the assistant message that requested
  // the call — including any text it wrote first — is already in chat.history, so the
  // model's own running commentary can be surfaced rather than just tool names.
  // Opened at what the session restored, not at zero: everything already in `history`
  // was narrated on the turn that produced it, and printing it again would replay the
  // whole session to stderr on every resume.
  let narrated = chat.history.length;
  let outstanding = 0;
  /** Labels for what this turn did, kept for the transcript if it gets interrupted. */
  const calls: string[] = [];

  const narrate = (): void => {
    const { lines, next } = newNarration(chat.history, narrated);
    for (const line of lines) progress.line(dim(line));
    narrated = next;
  };

  chat
    .onNewMessage(() => progress.step("thinking"))
    .onToolCallStart((call) => {
      narrate();
      outstanding++;
      const { name, args } = describeCall(call);
      // Once the interrupt has fired, the next call is the one that halts — that is the
      // stop itself, not work the agent did, so it stays off the list.
      if (!interrupt.requested) calls.push(args ? `${name} ${args}` : name);
      progress.line(`  ${name}${args ? ` ${dim(args)}` : ""}`);
      progress.step(name);
    })
    .onToolCallEnd(() => {
      if (--outstanding === 0) progress.step("thinking");
    });

  // Written before the model is called so that even a kill -9 leaves a session that
  // `-l` can see and `-s` can resume, rather than an orphaned transcript.
  saveSession(cfg, session);

  /** Everything an interrupted turn needs on the way out. Shared by the two ways a turn
   *  can be cut short: a tool halting on the flag, and a request cut mid-flight. */
  const finishInterrupted = (forced: boolean): void => {
    progress.stop();
    const spent = turnUsage(chat.history);
    session.usage = addUsage(session.usage, spent);
    session.messages = slim(chat.history);
    session.interrupted = calls;
    saveSession(cfg, session);
    const shown = renderInterrupted(calls, forced);
    appendTranscript(cfg, session, shown);
    render(shown, cfg);
    reportUsage(spent, session, values);
    process.stdout.write(`\n${session.mode} mode · continue with:\n↻  ${resume} -e\n`);
  };

  const cut = new AbortController();
  const onSigint = (): void => {
    if (!interrupt.requested) {
      interrupt.requested = true;
      progress.line(dim("⏸  stopping at the next tool call — ^C again to exit immediately"));
    } else if (!interrupt.hard) {
      interrupt.hard = true;
      cut.abort();
      progress.line(dim("✂  cut mid-request"));
    } else {
      progress.stop(); // third press: they want out now, and the turn is already saved
      throw new AgentExit(130);
    }
  };
  // Installed only around the model call. A Ctrl-C in the editor or the pager either
  // side of it should keep its default behaviour.
  process.on("SIGINT", onSigint);

  let res;
  try {
    progress.step("thinking");
    // Retry connection failures with exponential backoff (500ms, 1s, 2s) in case
    // LiteLLM is slow to start or temporarily unresponsive.
    res = await withRetry(() => chat.ask(prompt, { signal: cut.signal }), progress);
  } catch (err) {
    process.off("SIGINT", onSigint);
    progress.stop();
    // A cut request is the user's decision, not a failure: what the turn gathered is
    // kept and reported exactly as a graceful interrupt is.
    if (interrupt.requested) {
      finishInterrupted(true);
      return;
    }
    // Persist whatever the turn accomplished; otherwise a failure mid-loop throws
    // away every tool call it already made.
    const spent = turnUsage(chat.history);
    session.usage = addUsage(session.usage, spent);
    session.messages = slim(chat.history);
    saveSession(cfg, session);
    reportUsage(spent, session, values);
    const why = explainFailure(err, cfg);
    appendTranscript(cfg, session, `\n## Agent\n\n_Turn failed: ${why}_\n\n${YOU}\n\n${PROMPT_STUB}\n`);
    die(`${why}\n\nWork so far is saved. Continue with:\n↻  ${resume} -e`);
  }
  process.off("SIGINT", onSigint);
  progress.stop();

  // A halt on the interrupt flag returns normally rather than throwing. If the flag is
  // set but the model still produced a real answer, the turn beat the Ctrl-C — show that
  // answer rather than discarding work already paid for.
  if (interrupt.requested && res.content.trim() === INTERRUPT_HALT) {
    finishInterrupted(false);
    return;
  }
  // NodeLLM discards Anthropic's stop_reason, so a safety refusal arrives as nothing at
  // all. Say so, rather than writing a blank section the user has to puzzle over.
  const raw = res.content.trim();
  const readyToAct = raw.includes(READY_MARKER);
  const answer =
    raw.replace(READY_MARKER, "").trim() ||
    "_The model returned no content. This usually means the request was refused; the reason is not recoverable here. Try rephrasing._";

  const spent = turnUsage(chat.history);
  session.usage = addUsage(session.usage, spent);
  session.messages = slim(chat.history);

  // A halted turn ends with plumbing text ("Waiting for the user to approve: ..."),
  // not an answer, so the block the user must act on is shown in its place.
  let shown: string;
  if (session.pendingBash) {
    shown = renderApproval(session.pendingBash, session);
    appendTranscript(cfg, session, shown);
  } else if (session.declinedCommand) {
    shown = `Declined \`${session.declinedCommand}\`. Tell the agent what to do instead.`;
    appendTranscript(
      cfg,
      session,
      `\n## Declined\n\n\`${session.declinedCommand}\`\n\n${YOU}\n\n<!-- tell the agent what to do instead -->\n`,
    );
    session.declinedCommand = null;
  } else {
    shown = answer;
    const stub = readyToAct && session.mode === "plan" ? ACT_STUB : PROMPT_STUB;
    appendTranscript(cfg, session, `\n## Agent\n\n${answer}\n\n${YOU}\n\n${stub}\n`);
  }
  saveSession(cfg, session);

  render(shown, cfg);

  reportUsage(spent, session, values);
  const next = session.pendingBash ? " --approve" : " -e";
  process.stdout.write(`\n${session.mode} mode · continue with:\n↻  ${resume}${next}\n`);
}

/**
 * Top-level runner that wraps main() and ensures the stop hook runs exactly once.
 * All exit paths — normal return, AgentExit, or unexpected error — go through here.
 */
async function run(): Promise<void> {
  let cfg: Config | undefined;
  let exitCode = 0;
  try {
    cfg = loadConfig();
    await main(cfg);
  } catch (err) {
    if (err instanceof AgentExit) {
      exitCode = err.code;
      if (err.message) process.stderr.write(`${err.message}\n`);
    } else {
      exitCode = 1;
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
  } finally {
    if (cfg) runStopHook(cfg);
  }
  if (exitCode !== 0) process.exit(exitCode);
}

// Run as a CLI only when invoked directly (e.g. `node dist/agent.js` or the `bba` bin),
// not when the module is imported by a unit test.
const ENTRY = process.argv[1] ?? "";
if (ENTRY && path.basename(ENTRY) === "agent.js") {
  run();
}
