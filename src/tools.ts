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
  saveProjectConfig,
} from "./context.js";
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

const editFileArgs = z.object({
  path: z.string().describe("File path relative to the current directory"),
  old_string: z.string().describe("Exact text to replace; must appear exactly once"),
  new_string: z.string().describe("Replacement text"),
});
class EditFileTool extends SafeTool<z.infer<typeof editFileArgs>> {
  name = "edit_file";
  description = "Replace an exact, unique string in a file. Include surrounding context to make old_string unique.";
  schema = editFileArgs;
  protected async run({ path: p, old_string, new_string }: z.infer<typeof editFileArgs>) {
    this.requireAct();
    const abs = resolveSafe(p);
    const before = fs.readFileSync(abs, "utf8");
    const parts = before.split(old_string);
    if (parts.length === 1) throw new Error(`old_string not found in ${p}.`);
    if (parts.length > 2) throw new Error(`old_string appears ${parts.length - 1} times in ${p}; add context to make it unique.`);
    fs.writeFileSync(abs, parts.join(new_string));
    // The change is the tool's own arguments: old_string came out, new_string went in.
    // parts[0] is everything before the match, so its line count locates the edit.
    const c = report(`edit_file ${p}:${lineOf(parts[0] as string)}`, describeChange(old_string, new_string));
    return `Edited ${p} (${changeStat(c)}).`;
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
const APPROVAL_KEYS: Record<string, Approval> = { y: "yes", a: "always", n: "no" };

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
 *  writing the request into the transcript and ending the turn. */
async function askApproval(command: string, reason: string): Promise<Approval | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  const { progress } = ctx();
  progress.stop();
  process.stderr.write(
    `\n\x1b[1mrun_bash\x1b[0m wants to run:\n  \x1b[36m${command}\x1b[0m\n  \x1b[2m${reason}\x1b[0m\n` +
      `  [\x1b[1my\x1b[0m] run once   [\x1b[1ma\x1b[0m] always allow this command   [\x1b[1mn\x1b[0m] decline\n`,
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
});
class RunBashTool extends SafeTool<z.infer<typeof runBashArgs>> {
  name = "run_bash";
  description =
    "Run a shell command in the current directory. This ALWAYS requires the user to approve it first, which ends your turn and costs them a round trip. Every other tool runs immediately without asking. Use this only for what no other tool can do: running tests, git, package managers, build steps.";
  schema = runBashArgs;
  protected async run({ command, reason }: z.infer<typeof runBashArgs>) {
    this.requireAct();
    const { cfg, projectCfg, session } = ctx();
    const once = session.approvedOnce.indexOf(command);

    if (projectCfg.alwaysApprove.includes(command)) {
      // already blanket-approved
    } else if (once !== -1) {
      session.approvedOnce.splice(once, 1); // a one-shot approval is spent
    } else {
      const answer = await askApproval(command, reason);
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
        projectCfg.alwaysApprove.push(command);
        saveProjectConfig(cfg, projectCfg);
      }
    }
    const limit = cfg.bashTimeoutMs;
    const r = spawnSync("bash", ["-lc", command], {
      cwd: CWD,
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

const gitStatusArgs = z.object({});
class GitStatusTool extends SafeTool<z.infer<typeof gitStatusArgs>> {
  name = "git_status";
  description = "Show the working directory status: modified, staged, and untracked files.";
  schema = gitStatusArgs;
  protected async run(_args: z.infer<typeof gitStatusArgs>) {
    try {
      const out = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", cwd: CWD });
      return out.trim() ? cap(out) : "Working directory is clean.";
    } catch (err) {
      const e = err as { status?: number; code?: string; stderr?: Buffer };
      if (e.code === "ENOENT") throw new Error("git not found — ensure git is installed.");
      throw new Error(e.stderr?.toString().trim() || String(err));
    }
  }
}

const gitLogArgs = z.object({
  limit: z.number().int().min(1).optional().describe("Number of commits to show (default 10, or 1 if patch is true)"),
  patch: z.boolean().optional().describe("Include diff for each commit (default false)"),
  path: z.string().optional().describe("Optional file or directory to scope log to"),
  ref: z.string().optional().describe("Ref/branch to show log for (default HEAD)"),
});
class GitLogTool extends SafeTool<z.infer<typeof gitLogArgs>> {
  name = "git_log";
  description = "Show commit history with optional patches. Use patch=true to see what changed in commits.";
  schema = gitLogArgs;
  protected async run({ limit, patch = false, path: p, ref }: z.infer<typeof gitLogArgs>) {
    const defaultLimit = patch ? 1 : 10;
    const args = ["log", "--oneline"];
    if (patch) args.push("--patch");
    args.push("-n", String(limit ?? defaultLimit));
    if (ref) args.push(ref);
    if (p) args.push("--", p);
    try {
      const out = execFileSync("git", args, { encoding: "utf8", cwd: CWD, maxBuffer: 16 * 1024 * 1024 });
      return out.trim() ? cap(out) : "No commits found.";
    } catch (err) {
      const e = err as { status?: number; code?: string; stderr?: Buffer };
      if (e.code === "ENOENT") throw new Error("git not found — ensure git is installed.");
      throw new Error(e.stderr?.toString().trim() || String(err));
    }
  }
}

const gitMergeBaseArgs = z.object({
  ref1: z.string().optional().describe("First ref/branch (default HEAD)"),
  ref2: z.string().optional().describe("Second ref/branch (required unless autoDetectMain is true)"),
  autoDetectMain: z.boolean().optional().describe("Auto-detect main branch as ref2 (tries origin/main, origin/master, main, master)"),
});
class GitMergeBaseTool extends SafeTool<z.infer<typeof gitMergeBaseArgs>> {
  name = "git_merge_base";
  description = "Find the common ancestor commit between two refs. Useful for finding where a branch diverged from main.";
  schema = gitMergeBaseArgs;
  
  private detectMainBranch(): string | null {
    const candidates = ["origin/main", "origin/master", "main", "master"];
    for (const branch of candidates) {
      try {
        execFileSync("git", ["rev-parse", "--verify", branch], { encoding: "utf8", cwd: CWD, stdio: "pipe" });
        return branch;
      } catch {
        continue;
      }
    }
    return null;
  }

  protected async run({ ref1 = "HEAD", ref2, autoDetectMain = true }: z.infer<typeof gitMergeBaseArgs>) {
    let target = ref2;
    if (!target) {
      if (!autoDetectMain) throw new Error("ref2 is required when autoDetectMain is false.");
      target = this.detectMainBranch();
      if (!target) throw new Error("Could not auto-detect main branch. Tried: origin/main, origin/master, main, master.");
    }
    try {
      const out = execFileSync("git", ["merge-base", ref1, target], { encoding: "utf8", cwd: CWD });
      return out.trim();
    } catch (err) {
      const e = err as { status?: number; code?: string; stderr?: Buffer };
      if (e.code === "ENOENT") throw new Error("git not found — ensure git is installed.");
      throw new Error(e.stderr?.toString().trim() || String(err));
    }
  }
}

const gitDiffArgs = z.object({
  ref1: z.string().optional().describe("First ref/branch/commit (omit to compare working directory)"),
  ref2: z.string().optional().describe("Second ref/branch/commit (default HEAD if ref1 provided)"),
  path: z.string().optional().describe("Optional file or directory to scope diff to"),
  stat: z.boolean().optional().describe("Show only file stats instead of full diff (default false)"),
  cached: z.boolean().optional().describe("Show staged changes (default false)"),
});
class GitDiffTool extends SafeTool<z.infer<typeof gitDiffArgs>> {
  name = "git_diff";
  description = "Show differences between refs, commits, or working directory. Can compare any two commits/branches or show working directory changes.";
  schema = gitDiffArgs;
  protected async run({ ref1, ref2, path: p, stat = false, cached = false }: z.infer<typeof gitDiffArgs>) {
    const args = ["diff"];
    if (stat) args.push("--stat");
    if (cached) args.push("--cached");
    if (ref1) args.push(ref1);
    if (ref2) args.push(ref2);
    if (p) args.push("--", p);
    try {
      const out = execFileSync("git", args, { encoding: "utf8", cwd: CWD, maxBuffer: 16 * 1024 * 1024 });
      return out.trim() ? cap(out) : "No differences.";
    } catch (err) {
      const e = err as { status?: number; code?: string; stderr?: Buffer };
      if (e.code === "ENOENT") throw new Error("git not found — ensure git is installed.");
      throw new Error(e.stderr?.toString().trim() || String(err));
    }
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
];
