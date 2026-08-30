#!/usr/bin/env node
/**
 * barebones-agent — a coding agent that does one turn of work per process invocation.
 *
 * There is no input loop, instead it uses a code editor as a UI. Whenever the agent
 * needs a human — a follow-up prompt, an answer to a question, approval to run a
 * command — it records the request in the session transcript, saves state, and exits
 * with a hint for re-invoking.
 */
import { ModelRegistry, type Message, type NodeLLMCore } from "@node-llm/core";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { compactHistory, repairDangling } from "./compact.js";
import { Progress, dim } from "./progress.js";
import { PROVIDERS, createClient, providerSpec, summaryModel } from "./providers.js";
import { INTERRUPT_HALT, TOOLS } from "./tools.js";
import {
  APP_DIR,
  CONFIG_PATH,
  CWD,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_PRICING,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_READ_LINES,
  priceFor,
  saveConfig,
  setContext,
  zeroUsage,
  type Config,
  type Mode,
  type PendingBash,
  type PendingQuestion,
  type Renderer,
  type Interrupt,
  type ModelPrice,
  type Session,
  type Usage,
} from "./context.js";

// ---------------------------------------------------------------- constants

const MAX_TOOL_CALLS = 50;
const MAX_OUTPUT_TOKENS = 16_000;
const KEEP_RECENT_TURNS = 4;

/** GUI editors fork and return instantly; without a wait flag we would read the
 *  transcript back before the user has typed a single character. */
const GUI_EDITORS = new Set(["code", "code-insiders", "codium", "subl", "zed", "atom"]);

const YOU = "## You";
const PROMPT_STUB = "<!-- type your next prompt below, save, and re-run -->";
const ANSWER_STUB = "<!-- tick a box above, or just type an answer below -->";
const INTERRUPT_STUB = "<!-- ask what it was doing, or tell it where to go next -->";
const ACT_STUB =
  "<!-- The agent is ready to build this. Write !act on its own line to switch to act\n     mode and proceed, or reply with changes you want first. -->";
/** The model emits this to say a plan is finished and it wants the go-ahead. */
const READY_MARKER = "<!-- !act -->";

const DEFAULT_CONFIG: Config = {
  provider: "anthropic",
  model: "claude-opus-5",
  summaryModel: null,
  vertexProject: null,
  vertexRegion: "us-east5",
  editor: [],
  renderer: "auto",
  sessionDir: ".agent",
  compactAt: 0,
  alwaysApprove: [],
  tavilyApiKey: null,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  bashTimeoutMs: DEFAULT_BASH_TIMEOUT_MS,
  pricing: DEFAULT_PRICING,
};

// ---------------------------------------------------------------- helpers

function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function have(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

// ---------------------------------------------------------------- config

/** Config keys where null is a meaningful value rather than "leave the default". */
const NULLABLE = new Set(["tavilyApiKey", "summaryModel", "vertexProject"]);

function loadConfig(): Config {
  fs.mkdirSync(APP_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return { ...DEFAULT_CONFIG };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch (err) {
    die(`Could not parse ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const cfg = { ...DEFAULT_CONFIG };
  for (const [k, v] of Object.entries(raw)) {
    // Warn rather than throw, so a stale key never bricks a run.
    if (!(k in DEFAULT_CONFIG)) {
      process.stderr.write(`warning: unknown config key "${k}" in ${CONFIG_PATH}\n`);
      continue;
    }
    if (v !== null || NULLABLE.has(k)) (cfg as Record<string, unknown>)[k] = v;
  }
  // Merge per model, so overriding one rate doesn't drop every other model's.
  cfg.pricing = { ...DEFAULT_PRICING, ...(raw.pricing as Config["pricing"] | undefined) };
  return cfg;
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

function newSession(provider: string, model: string, mode: Mode): Session {
  return {
    id: randomUUID().slice(0, 8),
    provider,
    model,
    mode,
    announcedMode: null,
    messages: [],
    lastInputTokens: 0,
    usage: zeroUsage(),
    pendingQuestion: null,
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
  s.provider ??= "anthropic"; // ...and before there was more than one provider
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

/** Anthropic is the default, so naming it every time is noise; anything else is worth
 *  seeing, because the same model id can mean a different API and a different bill. */
export function modelLabel(s: Session): string {
  return s.provider === "anthropic" ? s.model : `${s.provider}:${s.model}`;
}

export function ago(ms: number): string {
  const secs = Math.max(0, (Date.now() - ms) / 1000);
  if (secs < 60) return `${Math.round(secs)}s ago`;
  if (secs < 3_600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3_600)}h ago`;
  return `${Math.round(secs / 86_400)}d ago`;
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
      // Back-filled here as well as in loadSession: this path reads the file directly,
      // and a session written before providers existed has no provider to label with.
      s.provider ??= "anthropic";
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
      : s.pendingQuestion
        ? "  ? awaiting an answer"
        : s.interrupted
          ? "  \u23f8 interrupted"
          : "";
    const next = s.pendingBash ? "--approve" : "-e";
    const cost = s.usage.priced ? money(s.usage.costUsd) : `${money(s.usage.costUsd)}+`;
    const meta = `${ago(mtimeMs)} \u00b7 ${s.mode} \u00b7 ${modelLabel(s)} \u00b7 ${s.usage.turns} turn${s.usage.turns === 1 ? "" : "s"} \u00b7 ${cost}`;
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
    fs.writeFileSync(p, `# session ${s.id}  ·  mode: ${s.mode}  ·  ${modelLabel(s)}\n`);
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

/** Checked boxes from the most recent question block. Only consulted while a
 *  question is actually pending, so stale ticks from earlier turns are ignored. */
export function readTickedOptions(cfg: Config, s: Session): string[] {
  const p = mdPath(cfg, s.id);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, "utf8");
  const start = text.lastIndexOf("## Agent asks");
  if (start === -1) return [];
  const picked: string[] = [];
  for (const m of text.slice(start).matchAll(/^- \[[xX]\] \*\*(.+?)\*\*/gm)) {
    if (m[1]) picked.push(m[1]);
  }
  return picked;
}

function ensurePromptStub(cfg: Config, s: Session): void {
  const p = mdPath(cfg, s.id);
  const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (!text.includes(`\n${YOU}\n`) || readPromptFromTranscript(cfg, s) !== "") {
    appendTranscript(cfg, s, `\n${YOU}\n\n${PROMPT_STUB}\n`);
  }
}

export function renderQuestion(q: PendingQuestion): string {
  const lines = [`\n## Agent asks\n`, `**${q.question}**\n`];
  if (q.options.length) {
    lines.push(
      `${q.options.map((o) => `- [ ] **${o.label}** — ${o.description}`).join("\n")}\n`,
    );
    if (q.multiSelect) lines.push(`_Tick as many as apply._\n`);
  }
  lines.push(`\n${YOU}\n\n${ANSWER_STUB}\n`);
  return lines.join("\n");
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

/** Byte-stable on purpose: this sits inside the cached prefix, so anything
 *  volatile here (a date, the cwd, the mode) would cost a cache hit every turn. */
const SYSTEM_PROMPT = `You are a coding agent working inside a single project directory.

You work in one turn per invocation. There is no interactive prompt: when you need the
user, call ask_user, and your turn ends until they answer.

Tools:
- list_tree, read_file, search_code and web_search run immediately and cost the user
  nothing. Use them freely, and prefer them over guessing.
- write_file, edit_file and delete_file modify the project. They are refused while the
  session is in plan mode.
- run_bash ALWAYS stops the session and asks the user to approve the command before it
  runs. That costs them a round trip, so reach for it only when no other tool can do the
  job: running tests, git, package managers, build steps. Never use it to read, search
  or list files.

Every path you touch must be inside the current directory.

Start by orienting yourself with list_tree or search_code rather than assuming a layout.
Read a file before you edit it. When you change code, match the surrounding style.

When you are in plan mode and the plan is finished and you want the user to go ahead,
end your response with exactly this line and nothing after it:

<!-- !act -->

That turns the reply the user is about to write into a prompt telling them they can type
!act to switch to act mode. Only use it when the plan genuinely needs no more input.

Write your final answer as Markdown. Be concise and concrete: reference files as
path:line, show only the code that matters, and say plainly what you did and what you
did not do.`;

export function modeMessage(mode: Mode): string {
  return mode === "plan"
    ? "[mode: plan] Investigate and produce a plan. Do not modify anything — the editing tools will refuse to run."
    : "[mode: act] You may modify files. Carry out the task.";
}

// ---------------------------------------------------------------- output

/**
 * What this turn cost, summed over every request the tool loop made.
 *
 * NodeLLM hangs `usage` on each assistant message it appends, and we strip that field
 * before persisting — so whatever carries usage in history right now is exactly this
 * turn. (chat.totalUsage would be simpler but silently omits cache_creation_tokens.)
 */
export function turnUsage(history: readonly Message[], price: ModelPrice | undefined): Usage {
  const u = zeroUsage();
  for (const m of history) {
    const x = m.usage;
    if (!x) continue;
    u.input += x.input_tokens ?? 0;
    u.cacheRead += x.cached_tokens ?? 0;
    u.cacheWrite += x.cache_creation_tokens ?? 0;
    u.output += x.output_tokens ?? 0;
    u.requests += 1;
  }
  u.turns = 1;
  return priceUsage(u, price);
}

/** Prices are per million tokens. An unpriced model still reports tokens; it just
 *  marks the running total as incomplete rather than quietly adding zero. A model with
 *  no separate cache rate is billed at the plain input rate for those tokens, which
 *  over-counts rather than under-counts. */
export function priceUsage(u: Usage, price: ModelPrice | undefined): Usage {
  if (!price) return { ...u, costUsd: 0, priced: u.requests === 0 };
  u.costUsd =
    (u.input * price.input +
      u.cacheRead * (price.cacheRead ?? price.input) +
      u.cacheWrite * (price.cacheWrite ?? price.input) +
      u.output * price.output) /
    1_000_000;
  return u;
}

export function money(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function addUsage(total: Usage, next: Usage): Usage {
  return {
    input: total.input + next.input,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    output: total.output + next.output,
    requests: total.requests + next.requests,
    turns: total.turns + next.turns,
    costUsd: total.costUsd + next.costUsd,
    priced: total.priced && next.priced,
  };
}

const n = (x: number): string => x.toLocaleString("en-US");

export function formatUsage(label: string, u: Usage, reportsCache = true): string {
  // Anthropic reports input_tokens as the uncached remainder, so the real input
  // volume is the three categories added together.
  const totalIn = u.input + u.cacheRead + u.cacheWrite;
  const cost = u.priced ? money(u.costUsd) : `${money(u.costUsd)}+ (some models unpriced)`;
  const requests = `${n(u.requests)} request${u.requests === 1 ? "" : "s"}`;

  // With no cache breakdown there is nothing to split, and printing "0% cached" would
  // describe the missing data rather than the run. The cost is a ceiling in that case:
  // tokens that were in fact served from cache are billed here at the full input rate.
  if (!reportsCache) {
    return `${label.padEnd(8)} in ${n(totalIn)}  out ${n(u.output)}  ·  ${requests}  ·  up to ${cost}`;
  }

  const hit = totalIn ? Math.round((u.cacheRead / totalIn) * 100) : 0;
  return (
    `${label.padEnd(8)} in ${n(totalIn)} (${n(u.cacheRead)} cached · ${n(u.cacheWrite)} written · ` +
    `${n(u.input)} fresh)  out ${n(u.output)}  ·  ${hit}% cached, ` +
    `${requests}  ·  ${cost}`
  );
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
 * Teach the registry about a model it does not ship with.
 *
 * The bundled registry lags new releases, and an unknown id fails the tool-support
 * check outright. `assumeModelExists` skips that check but also drops max_output_tokens
 * to an 8k fallback and logs a warning on every run; registering the model properly
 * avoids all three problems. The limits come from the provider table, which assumes
 * anything newer than the bundled registry is a current frontier model.
 *
 * This is a no-op for a provider whose models NodeLLM already knows — every DeepSeek
 * id is in the bundled registry — and load-bearing for Vertex, which has no entries
 * there at all.
 */
export function ensureModelKnown(session: Session, cfg: Config): void {
  const { model, provider } = session;
  if (ModelRegistry.find(model, provider)) return;
  const spec = providerSpec(provider);
  const price = priceFor(cfg, provider, model);
  ModelRegistry.save({
    id: model,
    name: model,
    provider,
    family: spec.family,
    context_window: spec.contextWindow,
    max_output_tokens: spec.maxOutputTokens,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    capabilities: ["streaming", "reasoning", "chat", "vision", "function_calling", "tools", "structured_output", "json_mode"],
    ...(price && {
      pricing: {
        text_tokens: {
          standard: {
            input_per_million: price.input,
            output_per_million: price.output,
            cached_input_per_million: price.cacheRead,
          },
        },
      },
    }),
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

/** A bare "Request timeout after 30000ms" tells the user nothing about what stalled. */
export function explainFailure(err: unknown, cfg: Config): string {
  const msg = err instanceof Error ? err.message : String(err);
  // fetchWithTimeout rethrows a raw AbortError when something other than its own timeout
  // controller fired — which, here, is always the user cutting the request.
  if (err instanceof Error && err.name === "AbortError") return "The request was cut short.";
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
  const argv1 = process.argv[1] ?? "";
  if (path.basename(argv1) === "bba") return "bba";
  const rel = path.relative(CWD, argv1);
  // Relative only while it stays inside the project; otherwise it is a wall of "../".
  return `node ${rel && !rel.startsWith("..") ? rel : argv1}`;
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

/**
 * Run `fn` with a fetch that a second Ctrl-C can cut.
 *
 * NodeLLM accepts an AbortSignal on ask(), but its Anthropic provider never forwards one
 * to fetch — it spreads unrecognised keys into the JSON body instead (the same channel
 * withParams({cache_control}) rides), so passing a signal would put "signal":{} in the
 * request and be rejected. Wrapping the global is the only seam left. It is scoped to
 * the model call and restored straight after; fetchWithTimeout always sets its own
 * timeout signal, so ours is merged in rather than replacing it.
 */
async function withCuttableFetch<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    original(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
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
  bba -l | --sessions             list this directory's sessions and how to resume each

  --plan | --act                  switch mode (persists in the session)
  --provider <name>               anthropic (default), deepseek or vertex; pinned to
                                  the session, so it cannot be changed on a resume
  --approve | --always-approve    allow the pending shell command
  --decline [reason]              refuse it; with no reason, hands back to you
  --compact                       compact the history now
  --timeout <s>                   per-request limit for the model API
  --bash-timeout <s>              limit for a single run_bash command
  --quiet                         no progress output
  --usage                         report this session's token spend and exit

  Ctrl-C stops the turn and saves it; press it twice to cut a request in flight.
  Write !act or !plan on its own line in the transcript to switch mode.
  --model <id>  --editor <cmd>  --compact-at <n>  --verbose  --help

Config: ${CONFIG_PATH}`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      session: { type: "string", short: "s" },
      file: { type: "string", short: "f" },
      edit: { type: "boolean", short: "e" },
      plan: { type: "boolean" },
      act: { type: "boolean" },
      approve: { type: "boolean" },
      "always-approve": { type: "boolean" },
      decline: { type: "boolean" },
      compact: { type: "boolean" },
      "compact-at": { type: "string" },
      model: { type: "string" },
      provider: { type: "string" },
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

  const cfg = loadConfig();
  if (values["compact-at"]) cfg.compactAt = Number(values["compact-at"]);
  if (values.timeout) cfg.requestTimeoutMs = Number(values.timeout) * 1000;
  if (values["bash-timeout"]) cfg.bashTimeoutMs = Number(values["bash-timeout"]) * 1000;

  if (values.sessions) {
    // Read-only, and never needs an id: this is how you find one.
    listSessions(cfg);
    return;
  }

  const mode: Mode = values.plan ? "plan" : values.act ? "act" : "act";
  const provider = values.provider || cfg.provider;
  if (!(provider in PROVIDERS)) {
    die(`Unknown provider "${provider}". Known: ${Object.keys(PROVIDERS).join(", ")}.`);
  }
  // cfg.model belongs to cfg.provider, so asking for a different provider on the command
  // line without naming a model means that provider's default, not the configured one.
  const model = values.model || (values.provider ? providerSpec(provider).defaultModel : cfg.model);
  const session = values.session ? loadSession(cfg, values.session) : newSession(provider, model, mode);
  // A session's history is written in one provider's dialect, so --provider on a resume
  // is a mistake worth naming rather than a switch to honour.
  if (values.session && values.provider && values.provider !== session.provider) {
    die(
      `Session ${session.id} runs on ${session.provider}; it cannot be moved to ${values.provider}. ` +
        `Start a new session instead.`,
    );
  }
  // Read off the session rather than the flags, so a resumed session keeps its own.
  const spec = providerSpec(session.provider);
  if (values.model) session.model = values.model;
  if (values.plan) session.mode = "plan";
  if (values.act) session.mode = "act";
  const progress = new Progress(!values.quiet);
  const interrupt: Interrupt = { requested: false, hard: false };
  setContext({ cfg, session, progress, interrupt });

  const resume = `${invocation()} -s ${session.id}`;

  if (values.usage) {
    // Read-only: report what the session has spent without calling the model.
    process.stdout.write(`${formatUsage("session", session.usage, spec.reportsCache)}\n`);
    process.stdout.write(
      `         across ${session.usage.turns} turn${session.usage.turns === 1 ? "" : "s"} · ${session.mode} mode · ${modelLabel(session)}\n`,
    );
    return;
  }
  let prompt = "";

  // --- resolve where this turn's prompt comes from -------------------------
  const pending = session.pendingBash;
  if (values.approve || values["always-approve"]) {
    if (!pending) die(`Nothing is awaiting approval in session ${session.id}.`);
    if (values["always-approve"]) {
      if (!cfg.alwaysApprove.includes(pending.command)) cfg.alwaysApprove.push(pending.command);
      saveConfig(cfg);
    } else {
      session.approvedOnce.push(pending.command);
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

  if (!prompt && values.edit) {
    ensurePromptStub(cfg, session);
    const [cmd, ...args] = resolveEditor(values.editor, cfg);
    const r = spawnSync(cmd as string, [...args, mdPath(cfg, session.id)], { stdio: "inherit" });
    if (r.error) die(`Could not launch editor "${cmd}": ${r.error.message}`);
  }

  if (!prompt) {
    const ticked = session.pendingQuestion ? readTickedOptions(cfg, session) : [];
    const typed = readPromptFromTranscript(cfg, session);
    prompt = [ticked.join(", "), typed].filter(Boolean).join(" — ");
  }

  if (!prompt) {
    ensurePromptStub(cfg, session);
    saveSession(cfg, session);
    die(`No prompt found. Write one under the last "## You" heading:\n\n↻  ${resume} -e`);
  }
  // A directive written into the prompt wins over the flags: it is the newer intent.
  const directive = extractMode(prompt);
  prompt = directive.prompt;
  if (directive.mode) session.mode = directive.mode;
  session.pendingQuestion = null;

  if (!values.quiet) {
    const switched = directive.mode || values.plan || values.act ? "  (switched)" : "";
    process.stderr.write(dim(`${session.mode} mode · ${modelLabel(session)} · session ${session.id}${switched}`) + "\n");
  }

  // --- run ----------------------------------------------------------------
  ensureModelKnown(session, cfg);
  // Typed rather than inferred: an evolving `any` here would silently unchecked the
  // whole chat chain built from it.
  let llm: NodeLLMCore;
  try {
    // Credentials are resolved here, not at startup: everything above this line —
    // listing sessions, reporting usage, collecting a prompt — works without them.
    llm = createClient(cfg, session.provider);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  const chat = llm
    .chat(session.model, {
      maxTokens: MAX_OUTPUT_TOKENS,
      // The default agentic loop cap is 5 rounds, which a real coding task blows
      // through immediately. (withToolCalls() is a different knob — parallelism.)
      maxToolCalls: MAX_TOOL_CALLS,
      requestTimeout: cfg.requestTimeoutMs,
    })
    .withInstructions(SYSTEM_PROMPT);

  if (values.compact || (cfg.compactAt > 0 && session.lastInputTokens > cfg.compactAt)) {
    const before = session.messages.length;
    const compacted = await compactHistory(session.messages, {
      llm,
      keepRecentTurns: KEEP_RECENT_TURNS,
      summaryModel: summaryModel(cfg, session.provider),
    });
    session.messages = compacted.messages;
    session.usage = addUsage(session.usage, priceUsage(compacted.usage, priceFor(cfg, session.provider, compacted.model)));
    // Compaction rewrites the prefix, so the next request cannot hit the cache.
    session.announcedMode = null;
    if (values.verbose) process.stderr.write(`compacted ${before} → ${session.messages.length} messages\n`);
  }

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
  // NodeLLM never emits cache_control itself; unknown params are spread straight into
  // the request body, which is how we reach Anthropic's top-level auto-caching. That
  // same spread is why it must not be sent elsewhere: on an OpenAI-shaped API it would
  // arrive as an unknown top-level field rather than being ignored.
  if (spec.cacheControl) chat.withParams({ cache_control: { type: "ephemeral", ttl: "1h" } });

  // Progress. By the time onToolCallStart fires, the assistant message that requested
  // the call — including any text it wrote first — is already in chat.history, so the
  // model's own running commentary can be surfaced rather than just tool names.
  let narrated = 0;
  let outstanding = 0;
  /** Labels for what this turn did, kept for the transcript if it gets interrupted. */
  const calls: string[] = [];

  const narrate = (): void => {
    const history = chat.history;
    for (let i = narrated; i < history.length; i++) {
      const m = history[i];
      if (m?.role !== "assistant") continue;
      const text = String(m.content ?? "").trim();
      if (text) progress.line(dim(text.split("\n").slice(0, 4).join("\n")));
    }
    narrated = history.length;
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
    session.usage = addUsage(session.usage, turnUsage(chat.history, priceFor(cfg, session.provider, session.model)));
    session.messages = slim(chat.history);
    session.interrupted = calls;
    saveSession(cfg, session);
    const shown = renderInterrupted(calls, forced);
    appendTranscript(cfg, session, shown);
    render(shown, cfg);
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
      process.exit(130);
    }
  };
  // Installed only around the model call. A Ctrl-C in the editor or the pager either
  // side of it should keep its default behaviour.
  process.on("SIGINT", onSigint);

  let res;
  try {
    progress.step("thinking");
    res = await withCuttableFetch(cut.signal, () => chat.ask(prompt));
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
    session.usage = addUsage(session.usage, turnUsage(chat.history, priceFor(cfg, session.provider, session.model)));
    session.messages = slim(chat.history);
    saveSession(cfg, session);
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

  const spent = turnUsage(chat.history, priceFor(cfg, session.provider, session.model));
  session.usage = addUsage(session.usage, spent);
  session.messages = slim(chat.history);
  session.lastInputTokens = res.input_tokens ?? 0;

  // A halted turn ends with plumbing text ("Waiting for the user to approve: ..."),
  // not an answer, so the block the user must act on is shown in its place.
  let shown: string;
  if (session.pendingQuestion) {
    shown = renderQuestion(session.pendingQuestion);
    appendTranscript(cfg, session, shown);
  } else if (session.pendingBash) {
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

  if (values.verbose) {
    process.stderr.write(
      `\n${formatUsage("turn", spent, spec.reportsCache)}\n${formatUsage("session", session.usage, spec.reportsCache)}\n`,
    );
  }
  const next = session.pendingBash ? " --approve" : " -e";
  process.stdout.write(`\n${session.mode} mode · continue with:\n↻  ${resume}${next}\n`);
}

// Run as a CLI only when invoked directly (e.g. `node dist/agent.js` or the `bba` bin),
// not when the module is imported by a unit test.
const ENTRY = process.argv[1] ?? "";
if (ENTRY && path.basename(ENTRY) === "agent.js") {
  main().catch((err: unknown) => {
    die(err instanceof Error ? (err.stack ?? err.message) : String(err));
  });
}
