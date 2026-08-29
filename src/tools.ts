/**
 * The agent's tools. All nine are registered on every request regardless of mode:
 * tool definitions sit at the front of the prompt-cache prefix, so varying the list
 * between plan and act would invalidate the whole cache on every switch. Plan mode is
 * enforced inside the mutating tools instead.
 */
import { Tool, z } from "@node-llm/core";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CONFIG_PATH,
  CWD,
  DEFAULT_TREE_DEPTH,
  MAX_READ_LINES,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
  TREE_SKIP,
  cap,
  ctx,
  resolveSafe,
  saveConfig,
} from "./context.js";

/** Tool failures are returned to the model as text rather than thrown, so it can
 *  read the message and correct itself instead of the run dying. */
abstract class SafeTool<T> extends Tool<T> {
  protected abstract run(args: T): Promise<unknown>;

  override async execute(args: T): Promise<unknown> {
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
    "Recursively list the directory structure with permissions, size and mtime, like `ls -al` over a tree. Use this first to orient yourself in an unfamiliar project.";
  schema = listTreeArgs;

  private perms(st: fs.Stats): string {
    const rwx = (n: number) => `${n & 4 ? "r" : "-"}${n & 2 ? "w" : "-"}${n & 1 ? "x" : "-"}`;
    const kind = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "-";
    return kind + rwx((st.mode >> 6) & 7) + rwx((st.mode >> 3) & 7) + rwx(st.mode & 7);
  }

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
      const indent = "  ".repeat(depth - 1);
      const size = st.isDirectory() ? "-" : String(st.size);
      const when = st.mtime.toISOString().slice(0, 16).replace("T", " ");
      out.push(`${this.perms(st)} ${size.padStart(9)} ${when} ${indent}${e.name}${e.isDirectory() ? "/" : ""}`);
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

const webSearchArgs = z.object({
  query: z.string().describe("What to search the web for"),
  max_results: z.number().int().min(1).max(10).optional().describe("How many results (default 5)"),
});
class WebSearchTool extends SafeTool<z.infer<typeof webSearchArgs>> {
  name = "web_search";
  description = "Search the web for current information. Use for docs, releases, and anything after your training cutoff.";
  schema = webSearchArgs;
  protected async run({ query, max_results = 5 }: z.infer<typeof webSearchArgs>) {
    const key = ctx().cfg.tavilyApiKey || process.env.TAVILY_API_KEY;
    if (!key) throw new Error(`Web search unavailable: set TAVILY_API_KEY, or "tavilyApiKey" in ${CONFIG_PATH}.`);
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: key, query, max_results, search_depth: "basic" }),
    });
    if (!res.ok) throw new Error(`Tavily returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { answer?: string; results?: { title: string; url: string; content: string }[] };
    const results = json.results ?? [];
    if (!results.length) return "No results.";
    const head = json.answer ? `${json.answer}\n\n` : "";
    return cap(head + results.map((r) => `## ${r.title}\n${r.url}\n${r.content}`).join("\n\n"));
  }
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
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return `Wrote ${p} (${content.split("\n").length} lines).`;
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
    const parts = fs.readFileSync(abs, "utf8").split(old_string);
    if (parts.length === 1) throw new Error(`old_string not found in ${p}.`);
    if (parts.length > 2) throw new Error(`old_string appears ${parts.length - 1} times in ${p}; add context to make it unique.`);
    fs.writeFileSync(abs, parts.join(new_string));
    return `Edited ${p}.`;
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

const askUserArgs = z.object({
  question: z.string().describe("The question, phrased so it can be answered directly"),
  options: z
    .array(z.object({ label: z.string(), description: z.string() }))
    .min(2)
    .max(6)
    .optional()
    .describe("Multiple-choice options, each a short label plus what choosing it means"),
  multi_select: z.boolean().optional().describe("Whether several options may be chosen"),
});
class AskUserTool extends SafeTool<z.infer<typeof askUserArgs>> {
  name = "ask_user";
  description =
    "Ask the user a question, optionally as multiple choice, when their answer would change what you build. This ends your turn: the question is written to the transcript and the user answers by re-invoking. Use it for genuine forks, not for things you can decide yourself.";
  schema = askUserArgs;
  protected async run({ question, options = [], multi_select = false }: z.infer<typeof askUserArgs>) {
    ctx().session.pendingQuestion = { question, options, multiSelect: multi_select };
    return this.halt(`Asked the user: ${question}`);
  }
}

type Approval = "yes" | "always" | "no";
const APPROVAL_KEYS: Record<string, Approval> = { y: "yes", a: "always", n: "no" };

/**
 * Read one keypress from the controlling terminal.
 *
 * Raw mode is what makes a single key enough — but it also stops the kernel turning
 * Ctrl-C into SIGINT, so \x03 has to be handled by hand or the prompt becomes a trap.
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
          done("");
          process.stderr.write("\n");
          process.exit(130);
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
  process.stderr.write(`  \x1b[2m→ ${answer === "no" ? "declined" : answer === "always" ? "always allowed" : "approved"}\x1b[0m\n`);
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
    const { cfg, session } = ctx();
    const once = session.approvedOnce.indexOf(command);

    if (cfg.alwaysApprove.includes(command)) {
      // already blanket-approved
    } else if (once !== -1) {
      session.approvedOnce.splice(once, 1); // a one-shot approval is spent
    } else {
      const answer = await askApproval(command, reason);
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
        cfg.alwaysApprove.push(command);
        saveConfig(cfg);
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

export const TOOLS = [
  ReadFileTool,
  ListTreeTool,
  SearchCodeTool,
  WebSearchTool,
  WriteFileTool,
  EditFileTool,
  DeleteFileTool,
  AskUserTool,
  RunBashTool,
];
