#!/usr/bin/env node
/**
 * barebones-agent — a coding agent that does one turn of work per process invocation.
 *
 * There is no input loop, instead it uses a code editor as a UI. Whenever the agent
 * needs a human — a follow-up prompt, an answer to a question, approval to run a
 * command — it records the request in the session transcript, saves state, and exits
 * with a hint for re-invoking.
 */
import { createLLM, type Message } from "@node-llm/core";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { compactHistory } from "./compact.js";
import { TOOLS } from "./tools.js";
import {
  APP_DIR,
  CONFIG_PATH,
  CWD,
  setContext,
  type Config,
  type Mode,
  type PendingBash,
  type PendingQuestion,
  type Renderer,
  type Session,
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

const DEFAULT_CONFIG: Config = {
  model: "claude-opus-5",
  editor: [],
  renderer: "auto",
  sessionDir: ".agent",
  compactAt: 0,
  alwaysApprove: [],
  tavilyApiKey: null,
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
    if (v !== null || k === "tavilyApiKey") (cfg as Record<string, unknown>)[k] = v;
  }
  return cfg;
}

function saveConfig(cfg: Config): void {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}

function resolveEditor(cliEditor: string | undefined, cfg: Config): string[] {
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

function newSession(cfg: Config, model: string, mode: Mode): Session {
  return {
    id: randomUUID().slice(0, 8),
    model,
    mode,
    announcedMode: null,
    messages: [],
    lastInputTokens: 0,
    pendingQuestion: null,
    pendingBash: null,
    approvedOnce: [],
  };
}

function loadSession(cfg: Config, id: string): Session {
  const p = jsonPath(cfg, id);
  if (!fs.existsSync(p)) die(`No session "${id}" under ${sessionDir(cfg)}/`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as Session;
}

/** `usage` and `reasoning` vary every turn. Re-sending them would perturb the
 *  serialized request and cost us the prompt cache, so they never get persisted.
 *  System messages are dropped too: withInstructions() re-applies the prompt on every
 *  run, so persisting it would stack one more copy per turn. */
function slim(messages: readonly Message[]): Message[] {
  return messages
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
function readPromptFromTranscript(cfg: Config, s: Session): string {
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
function readTickedOptions(cfg: Config, s: Session): string[] {
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

function renderQuestion(q: PendingQuestion): string {
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

function renderApproval(b: PendingBash, s: Session): string {
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

Write your final answer as Markdown. Be concise and concrete: reference files as
path:line, show only the code that matters, and say plainly what you did and what you
did not do.`;

function modeMessage(mode: Mode): string {
  return mode === "plan"
    ? "[mode: plan] Investigate and produce a plan. Do not modify anything — the editing tools will refuse to run."
    : "[mode: act] You may modify files. Carry out the task.";
}

// ---------------------------------------------------------------- output

function invocation(): string {
  const argv1 = process.argv[1] ?? "";
  if (path.basename(argv1) === "bba") return "bba";
  const rel = path.relative(CWD, argv1);
  // Relative only while it stays inside the project; otherwise it is a wall of "../".
  return `node ${rel && !rel.startsWith("..") ? rel : argv1}`;
}

function render(md: string, cfg: Config): void {
  const pick: Renderer =
    cfg.renderer === "auto" ? (have("glow") ? "glow" : have("bat") ? "bat" : "none") : cfg.renderer;
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
  bba -s <id> "prompt"            continue a session
  bba -s <id> -f prompt.md        take the prompt from a file
  bba -s <id> -e                  edit the transcript, then run what you wrote
  bba -s <id>                     run whatever is under the last "## You"

  --plan | --act                  switch mode (persists in the session)
  --approve | --always-approve    allow the pending shell command
  --decline [reason]              refuse it; with no reason, hands back to you
  --compact                       compact the history now
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
      editor: { type: "string" },
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

  const mode: Mode = values.plan ? "plan" : values.act ? "act" : "act";
  const session = values.session
    ? loadSession(cfg, values.session)
    : newSession(cfg, values.model || cfg.model, mode);
  if (values.model) session.model = values.model;
  if (values.plan) session.mode = "plan";
  if (values.act) session.mode = "act";
  setContext({ cfg, session });

  const resume = `${invocation()} -s ${session.id}`;
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
  session.pendingQuestion = null;

  // --- run ----------------------------------------------------------------
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) die("ANTHROPIC_API_KEY is not set.");

  const llm = createLLM({ provider: "anthropic", anthropicApiKey: apiKey });
  const chat = llm
    .chat(session.model, {
      // The bundled model registry lags new releases — claude-opus-5 is missing in
      // 1.17.0 — and an unknown id otherwise fails the tool-support check outright.
      // Skipping the check also drops max_tokens to 8k, so set it explicitly.
      assumeModelExists: true,
      maxTokens: MAX_OUTPUT_TOKENS,
      // The default agentic loop cap is 5 rounds, which a real coding task blows
      // through immediately. (withToolCalls() is a different knob — parallelism.)
      maxToolCalls: MAX_TOOL_CALLS,
    })
    .withInstructions(SYSTEM_PROMPT);

  if (values.compact || (cfg.compactAt > 0 && session.lastInputTokens > cfg.compactAt)) {
    const before = session.messages.length;
    session.messages = await compactHistory(session.messages, {
      llm,
      keepRecentTurns: KEEP_RECENT_TURNS,
    });
    // Compaction rewrites the prefix, so the next request cannot hit the cache.
    session.announcedMode = null;
    if (values.verbose) process.stderr.write(`compacted ${before} → ${session.messages.length} messages\n`);
  }

  if (session.messages.length) chat.addMessages(session.messages);
  if (session.announcedMode !== session.mode) {
    chat.addMessage({ role: "user", content: modeMessage(session.mode) });
    session.announcedMode = session.mode;
  }

  chat
    .withTools(TOOLS)
    // NodeLLM never emits cache_control itself; unknown params are spread straight
    // into the Anthropic request body, which is how we reach top-level auto-caching.
    .withParams({ cache_control: { type: "ephemeral", ttl: "1h" } });

  let res;
  try {
    res = await chat.ask(prompt);
  } catch (err) {
    // Persist whatever the turn accomplished; otherwise a failure mid-loop throws
    // away every tool call it already made.
    session.messages = slim(chat.history);
    saveSession(cfg, session);
    appendTranscript(cfg, session, `\n## Agent\n\n_Turn failed: ${err instanceof Error ? err.message : String(err)}_\n\n${YOU}\n\n${PROMPT_STUB}\n`);
    die(`${err instanceof Error ? err.message : String(err)}\n\n↻  ${resume} -e`);
  }
  // NodeLLM discards Anthropic's stop_reason, so a safety refusal arrives as nothing at
  // all. Say so, rather than writing a blank section the user has to puzzle over.
  const answer =
    res.content.trim() ||
    "_The model returned no content. This usually means the request was refused; the reason is not recoverable here. Try rephrasing._";

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
  } else {
    shown = answer;
    appendTranscript(cfg, session, `\n## Agent\n\n${answer}\n\n${YOU}\n\n${PROMPT_STUB}\n`);
  }
  saveSession(cfg, session);

  render(shown, cfg);

  if (values.verbose) {
    process.stderr.write(
      `\ntokens: in ${res.input_tokens} (cached ${res.cached_tokens ?? 0}) out ${res.output_tokens}\n`,
    );
  }
  const next = session.pendingBash ? " --approve" : " -e";
  process.stdout.write(`\n↻  ${resume}${next}\n`);
}

main().catch((err: unknown) => {
  die(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
