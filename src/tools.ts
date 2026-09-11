/**
 * The agent's tools. All eight are registered on every request regardless of mode:
 * tool definitions sit at the front of the prompt-cache prefix, so varying the list
 * between plan and act would invalidate the whole cache on every switch. Plan mode is
 * enforced inside the mutating tools instead.
 */
import { Tool, z } from "@node-llm/core";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CWD,
  DEFAULT_TREE_DEPTH,
  MAX_CHANGE_LINES,
  MAX_READ_LINES,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
  TREE_SKIP,
  cap,
  ctx,
  resolveSafe,
  runHook,
  saveProjectConfig,
} from "./context.js";
import { dim } from "./progress.js";
import { changeStat, describeChange, paintChange, type Change } from "./changes.js";

/** What a tool returns when the user has pressed Ctrl-C. Ending the loop through halt()
 *  rather than a throw means the tool call is still answered, so the history stays valid
 *  and every result gathered before the interrupt survives into the next turn. */
export const INTERRUPT_HALT = "The user interrupted this turn.";

/** Tool failures are returned to the model as text rather than thrown, so it can
 *  read the message and correct itself instead of the run dying. */
abstract class SafeTool<T> extends Tool<T> {
  protected abstract run(args: T): Promise<unknown>;

  override async execute(args: T): Promise<unknown> {
    // Checked before the work, never after: a tool that already ran keeps its result,
    // and the loop stops at the next call instead.
    if (ctx().interrupt.requested) return this.halt(INTERRUPT_HALT);
    try {
      return await this.run(args);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  protected requireAct(): void {
    if (ctx().session.mode === "plan") {
      throw new Error(
        "Unavailable in plan mode — you are planning, not editing. Describe the change instead.",
      );
    }
  }
}

const readFileArgs = z.object({
  path: z.string().describe("File path relative to the current directory"),
  offset: z.number().int().min(1).optional().describe("1-indexed first line to read"),
  limit: z.number().int().min(1).optional().describe(`Max lines to return (default ${MAX_READ_LINES})`),
});
class ReadFileTool extends SafeTool<z.infer<typeof readFileArgs>> {
  name = "read_file";
  description = "Read a UTF-8 text file from the current directory. Returns 1-indexed numbered lines.";
  schema = readFileArgs;
  protected async run({ path: p, offset = 1, limit = MAX_READ_LINES }: z.infer<typeof readFileArgs>) {
    const lines = fs.readFileSync(resolveSafe(p), "utf8").split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + Math.min(limit, MAX_READ_LINES));
    if (!slice.length) return `${p} has ${lines.length} lines; offset ${offset} is past the end.`;
    return cap(slice.map((l, i) => `${offset + i}\t${l}`).join("\n"));
  }
}

const listTreeArgs = z.object({
  path: z.string().optional().describe("Directory to list, relative to the current directory (default '.')"),
  depth: z.number().int().min(1).max(MAX_TREE_DEPTH).optional().describe(`Levels to descend (default ${DEFAULT_TREE_DEPTH})`),
  all: z.boolean().optional().describe("Include dotfiles and skipped directories like node_modules"),
});
class ListTreeTool extends SafeTool<z.infer<typeof listTreeArgs>> {
  name = "list_tree";
  description =
    "Recursively list the directory structure as an indented tree. Use this first to orient yourself in an unfamiliar project.";
  schema = listTreeArgs;

  private walk(dir: string, depth: number, max: number, all: boolean, out: string[]): void {
    if (depth > max || out.length >= MAX_TREE_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_TREE_ENTRIES) {
        out.push(`… truncated at ${MAX_TREE_ENTRIES} entries; narrow the path or depth.`);
        return;
      }
      if (!all && (e.name.startsWith(".") || TREE_SKIP.has(e.name))) continue;
      const abs = path.join(dir, e.name);
      // lstat, never stat: a symlink must not be followed out of the tree.
      const st = fs.lstatSync(abs);
      out.push(`${"  ".repeat(depth - 1)}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory() && !st.isSymbolicLink()) this.walk(abs, depth + 1, max, all, out);
    }
  }

  protected async run({ path: p = ".", depth = DEFAULT_TREE_DEPTH, all = false }: z.infer<typeof listTreeArgs>) {
    const root = resolveSafe(p);
    if (!fs.statSync(root).isDirectory()) throw new Error(`"${p}" is not a directory.`);
    const out: string[] = [];
    this.walk(root, 1, Math.min(depth, MAX_TREE_DEPTH), all, out);
    return out.length ? cap(`${p}/\n${out.join("\n")}`) : `${p}/ is empty.`;
  }
}

/** Header for a search result: the regex as given, and how much matched.
 *  ripgrep prints "file:line:match", so the file is everything before the first colon. */
function searchSummary(pattern: string, out: string): string {
  const lines = out.trim().split("\n");
  const files = new Set<string>();
  for (const l of lines) {
    const colon = l.indexOf(":");
    if (colon > 0) files.add(l.slice(0, colon));
  }
  const matches = `${lines.length} match${lines.length === 1 ? "" : "es"}`;
  return `/${pattern}/ — ${matches} in ${files.size} file${files.size === 1 ? "" : "s"}`;
}

const searchArgs = z.object({
  pattern: z.string().describe("Regular expression to search for"),
  glob: z.string().optional().describe("Only search files matching this glob, e.g. '*.ts'"),
  path: z.string().optional().describe("File or directory to search (default '.')"),
});
class SearchCodeTool extends SafeTool<z.infer<typeof searchArgs>> {
  name = "search_code";
  description =
    "Search the codebase with ripgrep. Returns a header naming the regex with its match and file counts, then file:line:match. Respects .gitignore.";
  schema = searchArgs;
  protected async run({ pattern, glob, path: p = "." }: z.infer<typeof searchArgs>) {
    const args = ["-n", "--no-heading", "--color=never", "--max-columns", "300"];
    if (glob) args.push("-g", glob);
    args.push("--", pattern, resolveSafe(p));
    try {
      const out = execFileSync("rg", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      // Summarise before cap(): a truncated body must still report the true totals.
      return out.trim() ? `${searchSummary(pattern, out)}\n${cap(out)}` : `No matches for /${pattern}/.`;
    } catch (err) {
      const e = err as { status?: number; code?: string; stderr?: Buffer };
      // ripgrep exits 1 for "no matches found", which is a result, not a failure.
      if (e.status === 1) return `No matches for /${pattern}/.`;
      if (e.code === "ENOENT") throw new Error("ripgrep not found — install it with `brew install ripgrep`.");
      throw new Error(e.stderr?.toString().trim() || String(err));
    }
  }
}

/**
 * Show what an editing tool just did.
 *
 * It goes to stderr through Progress, alongside the tool-call line it belongs to, so it
 * lands in the same stream as the rest of the turn's narration and disappears under
 * --quiet with it. Only the +/- counts go back to the model: it wrote the change and
 * does not need it read back, and the lines in the history are tokens paid for twice.
 */
function report(label: string, change: Change): Change {
  ctx().progress.line(paintChange(label, change, MAX_CHANGE_LINES));
  return change;
}

/** 1-indexed line that `before` ends on — where the text following it begins. */
function lineOf(before: string): number {
  return before.split("\n").length;
}

const writeFileArgs = z.object({
  path: z.string().describe("File path relative to the current directory"),
  content: z.string().describe("Full file contents"),
});
class WriteFileTool extends SafeTool<z.infer<typeof writeFileArgs>> {
  name = "write_file";
  description = "Create a file or overwrite it entirely. For a targeted change to an existing file, prefer edit_file.";
  schema = writeFileArgs;
  protected async run({ path: p, content }: z.infer<typeof writeFileArgs>) {
    this.requireAct();
    const abs = resolveSafe(p);
    // Read before the write, so an overwrite shows what it replaced as well as what it
    // put there. A file that does not exist yet has nothing removed, which is exactly
    // the all-additions display a creation should get.
    const existed = fs.existsSync(abs);
    const before = existed ? fs.readFileSync(abs, "utf8") : "";
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    const c = report(`write_file ${p}${existed ? "" : " (new file)"}`, describeChange(before, content));
    return `Wrote ${p} (${content.split("\n").length} lines, ${changeStat(c)}).`;
  }
}

const singleEdit = z.object({
  old_string: z.string().describe("Exact text to replace; must appear exactly once in the file"),
  new_string: z.string().describe("Replacement text"),
});
const editFileArgs = z.object({
  path: z.string().describe("File path relative to the current directory"),
  edits: z.array(singleEdit).describe("List of edits to apply. They are validated and applied together, so an error in any edit aborts the whole operation."),
});
class EditFileTool extends SafeTool<z.infer<typeof editFileArgs>> {
  name = "edit_file";
  description =
    "Replace exact strings in a file. Each edit replaces old_string with new_string; all edits must match exactly once. Edits are applied in file order, so earlier edits can affect the positions of later ones.";
  schema = editFileArgs;
  protected async run({ path: p, edits }: z.infer<typeof editFileArgs>) {
    this.requireAct();
    if (edits.length === 0) throw new Error("No edits provided.");
    const abs = resolveSafe(p);
    let content = fs.readFileSync(abs, "utf8");

    // Phase 1: Validate all edits find exactly one match
    interface Match {
      old_string: string;
      new_string: string;
      index: number;
    }
    const matches: Match[] = [];
    for (const { old_string, new_string } of edits) {
      const parts = content.split(old_string);
      if (parts.length === 1) throw new Error(`old_string not found in ${p}: ${JSON.stringify(old_string.slice(0, 60))}${old_string.length > 60 ? "..." : ""}`);
      if (parts.length > 2) throw new Error(`old_string appears ${parts.length - 1} times in ${p}; add context to make it unique: ${JSON.stringify(old_string.slice(0, 60))}${old_string.length > 60 ? "..." : ""}`);
      matches.push({ old_string, new_string, index: (parts[0] as string).length });
    }

    // Phase 2: Sort by position descending (apply from bottom to top to preserve offsets)
    matches.sort((a, b) => b.index - a.index);

    // Phase 3: Check for overlaps (edits whose ranges intersect)
    for (let i = 0; i < matches.length - 1; i++) {
      const current = matches[i]!;
      const next = matches[i + 1]!;
      // current starts at current.index, ends at current.index + current.old_string.length
      // next starts at next.index (which is <= current.index since sorted descending)
      if (next.index + next.old_string.length > current.index) {
        throw new Error(`Overlapping edits: one edit ends at position ${next.index + next.old_string.length} but another starts at ${current.index}.`);
      }
    }

    // Phase 4: Apply edits in reverse order and report each one
    const stats: string[] = [];
    for (const { old_string, new_string, index } of matches) {
      const before = content.slice(0, index);
      const after = content.slice(index + old_string.length);
      content = before + new_string + after;
      const c = report(`edit_file ${p}:${lineOf(before)}`, describeChange(old_string, new_string));
      stats.push(changeStat(c));
    }

    fs.writeFileSync(abs, content);
    // Report in original (file) order, which is reverse of how we applied them
    const statsSummary = stats.reverse().join(", ");
    return edits.length === 1
      ? `Edited ${p} (${statsSummary}).`
      : `Edited ${p} (${edits.length} edits: ${statsSummary}).`;
  }
}

const deleteFileArgs = z.object({
  path: z.string().describe("File path relative to the current directory"),
});
class DeleteFileTool extends SafeTool<z.infer<typeof deleteFileArgs>> {
  name = "delete_file";
  description = "Delete a file in the current directory.";
  schema = deleteFileArgs;
  protected async run({ path: p }: z.infer<typeof deleteFileArgs>) {
    this.requireAct();
    const abs = resolveSafe(p);
    if (fs.statSync(abs).isDirectory()) throw new Error(`"${p}" is a directory; this tool only deletes files.`);
    fs.unlinkSync(abs);
    return `Deleted ${p}.`;
  }
}

type Approval = "yes" | "always" | "no";
const APPROVAL_KEYS: Record<string, Approval> = {
  y: "yes",
  " ": "yes",
  "\r": "yes",
  "\n": "yes",
  a: "always",
  n: "no",
};

/**
 * Characters that are forbidden in suffix arguments because they enable
 * command injection, file operations, or other dangerous shell behavior.
 */
const DANGEROUS_SUFFIX_CHARS = /[$`<>]/;

/**
 * Check if grep arguments contain the -f flag (reads patterns from file).
 * Must handle quoted strings to avoid false positives like grep 'rm -rf'.
 */
function hasGrepFileFlag(args: string): boolean {
  let i = 0;
  while (i < args.length) {
    // Skip quoted strings
    const quoted = matchQuotedString(args, i);
    if (quoted) {
      i += quoted.length;
      continue;
    }
    // Look for -f or --file flag (possibly combined like -nf, -Ef)
    if (args[i] === "-") {
      const flagMatch = args.slice(i).match(/^--?file\b|^-[a-zA-Z]*f\b/);
      if (flagMatch) return true;
    }
    i++;
  }
  return false;
}

/**
 * Match a quoted string (single or double quotes) that may contain pipes.
 * Returns the full quoted string including quotes, or null if no match at position.
 */
function matchQuotedString(s: string, pos: number): string | null {
  const quote = s[pos];
  if (quote !== '"' && quote !== "'") return null;
  let i = pos + 1;
  while (i < s.length) {
    if (s[i] === quote) return s.slice(pos, i + 1);
    if (s[i] === "\\" && quote === '"') i++; // skip escaped char in double quotes
    i++;
  }
  return null; // unclosed quote
}

/**
 * Find the last unquoted pipe in a string, respecting single and double quotes.
 * Returns the index of the pipe, or -1 if not found.
 */
function findLastUnquotedPipe(s: string): number {
  let lastPipe = -1;
  let i = 0;
  while (i < s.length) {
    const quoted = matchQuotedString(s, i);
    if (quoted) {
      i += quoted.length;
      continue;
    }
    if (s[i] === "|") lastPipe = i;
    i++;
  }
  return lastPipe;
}

/**
 * Strip common shell suffixes that don't change what command is being run:
 * - `2>&1` (stderr redirection)
 * - `| head ...`, `| tail ...`, `| grep ...` (output filtering)
 *
 * Returns the base command (to check against alwaysApprove) and the suffix.
 * Only these specific, safe transformations are recognized — arbitrary pipes
 * like `| wc -l` are left as part of the base command.
 *
 * Security: Suffixes containing dangerous characters ($, `, <, >) are rejected
 * to prevent command substitution and file redirection attacks. The -f flag
 * is forbidden for grep to prevent reading arbitrary files.
 */
export function extractBaseCommand(command: string): { base: string; suffix: string } {
  let base = command.trim();
  let suffix = "";

  // Repeatedly strip recognized suffixes from the end.
  // Order matters: we strip from the end, so `cmd 2>&1 | grep x` strips `| grep x` first.
  while (true) {
    // Find the last unquoted pipe to check for head/tail/grep
    const pipeIdx = findLastUnquotedPipe(base);
    if (pipeIdx !== -1) {
      const afterPipe = base.slice(pipeIdx);
      // Match pipe to head/tail/grep with optional arguments
      const pipeMatch = afterPipe.match(/^\|\s*(head|tail|grep)(\s+.*)?$/);
      if (pipeMatch) {
        const args = pipeMatch[2] || "";
        const cmd = pipeMatch[1];
        
        // Reject suffixes with dangerous characters (command substitution, redirection)
        if (DANGEROUS_SUFFIX_CHARS.test(args)) break;
        
        // Reject grep -f/--file (reads patterns from file)
        if (cmd === "grep" && hasGrepFileFlag(args)) break;
        
        // Include any whitespace before the pipe in the suffix
        const beforePipe = base.slice(0, pipeIdx);
        const wsMatch = beforePipe.match(/\s+$/);
        const ws = wsMatch ? wsMatch[0] : "";
        
        suffix = ws + afterPipe + suffix;
        base = beforePipe.trimEnd();
        continue;
      }
    }
    
    // Match trailing 2>&1
    const redirMatch = base.match(/\s+2>&1$/);
    if (redirMatch) {
      suffix = redirMatch[0] + suffix;
      base = base.slice(0, -redirMatch[0].length).trimEnd();
      continue;
    }
    break;
  }

  return { base, suffix };
}

/**
 * Read one keypress from the controlling terminal.
 *
 * Raw mode is what makes a single key enough — but it also stops the kernel turning
 * Ctrl-C into SIGINT, so \x03 has to be handled by hand or the prompt becomes a trap.
 * It records an interrupt rather than exiting, so the turn's work is saved on the way
 * out like any other Ctrl-C.
 */
function readKey(valid: string[]): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let settled = false;
    const done = (key: string): void => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      resolve(key);
    };
    // A chunk is not a keystroke: terminals deliver escape sequences, pastes and
    // stray control bytes in one read, so scan it rather than compare it whole.
    const onData = (buf: Buffer): void => {
      for (const ch of buf.toString().toLowerCase()) {
        if (ch === "\u0003") {
          ctx().interrupt.requested = true;
          process.stderr.write("\n");
          return done("");
        }
        if (valid.includes(ch)) return done(ch);
      }
    };
    // stdin closing with no answer is not consent.
    const onEnd = (): void => done("");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}

/** Returns null when there is no terminal to ask on; the caller then falls back to
 *  writing the request into the transcript and ending the turn.
 *  
 *  When the command has a recognized suffix (pipes to head/tail/grep, 2>&1), the suffix
 *  is displayed dimmed to show that approval applies to the base command. */
async function askApproval(command: string, reason: string, workingDirectory?: string): Promise<Approval | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  const { progress } = ctx();
  progress.stop();
  
  // Show base command in cyan, suffix dimmed — user approves the base
  const { base, suffix } = extractBaseCommand(command);
  const displayCmd = suffix
    ? `\x1b[36m${base}\x1b[0m${dim(suffix)}`
    : `\x1b[36m${command}\x1b[0m`;
  const alsoVariations = suffix ? " (and variations)" : "";
  const inDir = workingDirectory ? `  ${dim(`in ${workingDirectory}/`)}\n` : "";
  
  process.stderr.write(
    `\n\x1b[1mrun_bash\x1b[0m wants to run:\n  ${displayCmd}\n${inDir}  \x1b[2m${reason}\x1b[0m\n` +
      `  [\x1b[1my\x1b[0m/\x1b[1mspace\x1b[0m/\x1b[1menter\x1b[0m] run once   [\x1b[1ma\x1b[0m] always allow this command${alsoVariations}   [\x1b[1mn\x1b[0m] decline\n`,
  );
  const answer = APPROVAL_KEYS[await readKey(Object.keys(APPROVAL_KEYS))] ?? "no";
  // Ctrl-C here is an interrupt, not a refusal — saying "declined" would tell both the
  // user and the model something they never chose.
  const said = ctx().interrupt.requested
    ? "interrupted"
    : answer === "no"
      ? "declined"
      : answer === "always"
        ? "always allowed"
        : "approved";
  process.stderr.write(`  \x1b[2m→ ${said}\x1b[0m\n`);
  progress.step("run_bash");
  return answer;
}

const runBashArgs = z.object({
  command: z.string().describe("The exact shell command to run"),
  reason: z.string().describe("Why this command is needed and what you expect it to show"),
  workingDirectory: z.string().optional().describe("Subdirectory to run the command in (relative to project root). Use this instead of `cd dir &&` prefix."),
});
class RunBashTool extends SafeTool<z.infer<typeof runBashArgs>> {
  name = "run_bash";
  description =
    "Run a shell command in the current directory. This ALWAYS requires the user to approve it first, which ends your turn and costs them a round trip. Every other tool runs immediately without asking. Use this only for what no other tool can do: running tests, package managers, build steps. Never use it to read, search or list files — use the read-only tools instead, including git_* tools for repository information. Some commands may be pre-approved for this project; you can add | head, | tail, | grep, or 2>&1 to any approved command and it will also be approved. NEVER prefix a bash command with `cd subdir &&` or similar -- instead, use workingDirectory to run in a subdirectory.";
  schema = runBashArgs;
  protected async run({ command, reason, workingDirectory }: z.infer<typeof runBashArgs>) {
    this.requireAct();
    const { cfg, projectCfg, session } = ctx();
    
    // Resolve and validate working directory if provided
    let cwd = CWD;
    if (workingDirectory) {
      cwd = resolveSafe(workingDirectory);
      if (!fs.statSync(cwd).isDirectory()) {
        throw new Error(`workingDirectory "${workingDirectory}" is not a directory.`);
      }
    }
    
    // Extract base command for approval matching. Variations like `npm test 2>&1 | head`
    // are auto-approved if the base (`npm test`) is in the list.
    const { base } = extractBaseCommand(command);
    const onceIdx = session.approvedOnce.indexOf(base);

    if (projectCfg.alwaysApprove.includes(base)) {
      // already blanket-approved (base command matches)
    } else if (onceIdx !== -1) {
      session.approvedOnce.splice(onceIdx, 1); // a one-shot approval is spent
    } else {
      // Run the confirm hook to notify the user that approval is needed
      runHook(cfg.confirmHook);
      const answer = await askApproval(command, reason, workingDirectory);
      if (ctx().interrupt.requested) return this.halt(INTERRUPT_HALT);
      if (answer === null) {
        // Nothing to prompt on, so fall back to asking through the transcript.
        session.pendingBash = { command, reason };
        return this.halt(`Waiting for the user to approve: ${command}`);
      }
      if (answer === "no") {
        session.declinedCommand = command;
        return this.halt(`The user declined to run \`${command}\`.`);
      }
      if (answer === "always") {
        // Save the base command, not the full command with suffixes
        projectCfg.alwaysApprove.push(base);
        saveProjectConfig(cfg, projectCfg);
      }
    }
    const limit = cfg.bashTimeoutMs;
    const r = spawnSync("bash", ["-lc", command], {
      cwd,
      encoding: "utf8",
      timeout: limit,
      maxBuffer: 8 * 1024 * 1024,
    });
    // spawnSync signals a timeout kill via SIGTERM, sometimes without an error object.
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGTERM") {
      throw new Error(
        `Command timed out after ${Math.round(limit / 1000)}s: \`${command}\`. ` +
          `Tell the user they can retry with a longer limit via --bash-timeout <seconds>, ` +
          `or suggest a faster command.`,
      );
    }
    if (r.error) throw new Error(r.error.message);
    const out = [`exit ${r.status ?? "null"}`];
    if (r.stdout?.trim()) out.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
    if (r.stderr?.trim()) out.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
    return cap(out.join("\n"));
  }
}

/**
 * Execute a git command with optional stderr capture.
 * 
 * When showStderr is false (default), stderr is suppressed to reduce noise.
 * When showStderr is true, stderr is captured and appended to stdout with a separator.
 * 
 * @param args - Git command arguments (e.g. ["status", "--porcelain"])
 * @param cwd - Working directory for the command
 * @param showStderr - Whether to capture and include stderr in output
 * @param emptyMessage - Message to return when output is empty (optional)
 * @param maxBuffer - Maximum buffer size for stdout/stderr (default 1MB)
 * @returns Command output, possibly with stderr appended
 */
function execGit(
  args: string[],
  cwd: string,
  showStderr: boolean,
  emptyMessage?: string,
  maxBuffer = 1024 * 1024
): string {
  if (showStderr) {
    // Use spawnSync to capture both stdout and stderr
    const result = spawnSync("git", args, { encoding: "utf8", cwd, maxBuffer });
    if (result.error) {
      const e = result.error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw new Error("git not found — ensure git is installed.");
      throw new Error(e.message);
    }
    if (result.status !== 0) {
      const stdout = result.stdout?.trim() || "";
      const stderr = result.stderr?.trim() || "";
      const combined = stdout ? `${stdout}\n--- stderr ---\n${stderr}` : stderr;
      throw new Error(combined || `git exited with status ${result.status}`);
    }
    const output = [result.stdout.trim()];
    if (result.stderr?.trim()) {
      output.push("--- stderr ---");
      output.push(result.stderr.trim());
    }
    const combined = output.join("\n");
    return combined || emptyMessage || "";
  } else {
    // Default: swallow stderr
    try {
      const out = execFileSync("git", args, { 
        encoding: "utf8", 
        cwd, 
        maxBuffer,
        stdio: ['pipe', 'pipe', 'ignore'] 
      });
      return out.trim() || emptyMessage || "";
    } catch (err) {
      const e = err as { status?: number; code?: string };
      if (e.code === "ENOENT") throw new Error("git not found — ensure git is installed.");
      throw new Error(String(err));
    }
  }
}

const gitStatusArgs = z.object({
  workingDirectory: z.string().optional().describe("Subdirectory to run the command in (relative to project root). Use this instead of `cd dir &&` prefix."),
  showStderr: z.boolean().optional().describe("Include stderr in output (default false)"),
});
class GitStatusTool extends SafeTool<z.infer<typeof gitStatusArgs>> {
  name = "git_status";
  description = "Show the working directory status: modified, staged, and untracked files.";
  schema = gitStatusArgs;
  protected async run({ workingDirectory, showStderr = false }: z.infer<typeof gitStatusArgs>) {
    let cwd = CWD;
    if (workingDirectory) {
      cwd = resolveSafe(workingDirectory);
      if (!fs.statSync(cwd).isDirectory()) {
        throw new Error(`workingDirectory "${workingDirectory}" is not a directory.`);
      }
    }
    const out = execGit(["status", "--porcelain"], cwd, showStderr, "Working directory is clean.");
    return cap(out);
  }
}

const gitLogArgs = z.object({
  limit: z.number().int().min(1).optional().describe("Number of commits to show (default 10, or 1 if patch is true)"),
  patch: z.boolean().optional().describe("Include diff for each commit (default false)"),
  path: z.string().optional().describe("Optional file or directory to scope log to"),
  ref: z.string().optional().describe("Ref/branch to show log for (default HEAD)"),
  workingDirectory: z.string().optional().describe("Subdirectory to run the command in (relative to project root). Use this instead of `cd dir &&` prefix."),
  showStderr: z.boolean().optional().describe("Include stderr in output (default false)"),
});
class GitLogTool extends SafeTool<z.infer<typeof gitLogArgs>> {
  name = "git_log";
  description = "Show commit history with optional patches. Use patch=true to see what changed in commits.";
  schema = gitLogArgs;
  protected async run({ limit, patch = false, path: p, ref, workingDirectory, showStderr = false }: z.infer<typeof gitLogArgs>) {
    let cwd = CWD;
    if (workingDirectory) {
      cwd = resolveSafe(workingDirectory);
      if (!fs.statSync(cwd).isDirectory()) {
        throw new Error(`workingDirectory "${workingDirectory}" is not a directory.`);
      }
    }
    const defaultLimit = patch ? 1 : 10;
    const args = ["log", "--oneline"];
    if (patch) args.push("--patch");
    args.push("-n", String(limit ?? defaultLimit));
    if (ref) args.push(ref);
    if (p) args.push("--", p);
    const out = execGit(args, cwd, showStderr, "No commits found.", 16 * 1024 * 1024);
    return cap(out);
  }
}

const gitMergeBaseArgs = z.object({
  ref1: z.string().optional().describe("First ref/branch (default HEAD)"),
  ref2: z.string().optional().describe("Second ref/branch (required unless autoDetectMain is true)"),
  autoDetectMain: z.boolean().optional().describe("Auto-detect main branch as ref2 (tries origin/main, origin/master, main, master)"),
  workingDirectory: z.string().optional().describe("Subdirectory to run the command in (relative to project root). Use this instead of `cd dir &&` prefix."),
  showStderr: z.boolean().optional().describe("Include stderr in output (default false)"),
});
class GitMergeBaseTool extends SafeTool<z.infer<typeof gitMergeBaseArgs>> {
  name = "git_merge_base";
  description = "Find the common ancestor commit between two refs. Useful for finding where a branch diverged from main.";
  schema = gitMergeBaseArgs;
  
  private detectMainBranch(cwd: string): string | null {
    const candidates = ["origin/main", "origin/master", "main", "master"];
    for (const branch of candidates) {
      try {
        execFileSync("git", ["rev-parse", "--verify", branch], { encoding: "utf8", cwd, stdio: "pipe" });
        return branch;
      } catch {
        continue;
      }
    }
    return null;
  }

  protected async run({ ref1 = "HEAD", ref2, autoDetectMain = true, workingDirectory, showStderr = false }: z.infer<typeof gitMergeBaseArgs>) {
    let cwd = CWD;
    if (workingDirectory) {
      cwd = resolveSafe(workingDirectory);
      if (!fs.statSync(cwd).isDirectory()) {
        throw new Error(`workingDirectory "${workingDirectory}" is not a directory.`);
      }
    }
    let target = ref2;
    if (!target) {
      if (!autoDetectMain) throw new Error("ref2 is required when autoDetectMain is false.");
      target = this.detectMainBranch(cwd);
      if (!target) throw new Error("Could not auto-detect main branch. Tried: origin/main, origin/master, main, master.");
    }
    return execGit(["merge-base", ref1, target], cwd, showStderr);
  }
}

const gitDiffArgs = z.object({
  ref1: z.string().optional().describe("First ref/branch/commit (omit to compare working directory)"),
  ref2: z.string().optional().describe("Second ref/branch/commit (default HEAD if ref1 provided)"),
  path: z.string().optional().describe("Optional file or directory to scope diff to"),
  stat: z.boolean().optional().describe("Show only file stats instead of full diff (default false)"),
  cached: z.boolean().optional().describe("Show staged changes (default false)"),
  workingDirectory: z.string().optional().describe("Subdirectory to run the command in (relative to project root). Use this instead of `cd dir &&` prefix."),
  showStderr: z.boolean().optional().describe("Include stderr in output (default false)"),
});
class GitDiffTool extends SafeTool<z.infer<typeof gitDiffArgs>> {
  name = "git_diff";
  description = "Show differences between refs, commits, or working directory. Can compare any two commits/branches or show working directory changes.";
  schema = gitDiffArgs;
  protected async run({ ref1, ref2, path: p, stat = false, cached = false, workingDirectory, showStderr = false }: z.infer<typeof gitDiffArgs>) {
    let cwd = CWD;
    if (workingDirectory) {
      cwd = resolveSafe(workingDirectory);
      if (!fs.statSync(cwd).isDirectory()) {
        throw new Error(`workingDirectory "${workingDirectory}" is not a directory.`);
      }
    }
    const args = ["diff"];
    if (stat) args.push("--stat");
    if (cached) args.push("--cached");
    if (ref1) args.push(ref1);
    if (ref2) args.push(ref2);
    if (p) args.push("--", p);
    const out = execGit(args, cwd, showStderr, "No differences.", 16 * 1024 * 1024);
    return cap(out);
  }
}

const getPwdArgs = z.object({});
class GetPwdTool extends SafeTool<z.infer<typeof getPwdArgs>> {
  name = "get_pwd";
  description = "Get the current working directory (pwd). Returns the absolute path of the project root.";
  schema = getPwdArgs;
  protected async run(_args: z.infer<typeof getPwdArgs>) {
    return CWD;
  }
}

export const TOOLS = [
  ReadFileTool,
  ListTreeTool,
  SearchCodeTool,
  WriteFileTool,
  EditFileTool,
  DeleteFileTool,
  RunBashTool,
  GitStatusTool,
  GitLogTool,
  GitMergeBaseTool,
  GitDiffTool,
  GetPwdTool,
];
