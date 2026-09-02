/**
 * What an editing tool changed, painted for the terminal.
 *
 * There is no diff algorithm here, and no `diff` subprocess, because neither is needed:
 * edit_file is *given* the before and after text as `old_string` and `new_string`, and
 * write_file is given the whole new contents. The change is already in the tool's
 * arguments — the only work left is showing it.
 *
 * That also makes this more faithful than a re-derived diff would be. `old_string` is
 * the span the model chose to replace, so printing it verbatim shows the edit the way
 * the model meant it, rather than the minimal one an algorithm would find inside it.
 */
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

/** One editing tool call, as the lines it took out and the lines it put in. */
export interface Change {
  removed: string[];
  added: string[];
}

/** A line in a diff, either unchanged, removed, or added. */
interface DiffLine {
  kind: "unchanged" | "removed" | "added";
  text: string;
}

/**
 * Compute a simple diff between removed and added lines.
 * 
 * Uses a basic longest common subsequence approach to identify unchanged lines.
 * Lines that appear in both removed and added in the same order are marked as
 * unchanged; others are marked as removed or added.
 */
function computeDiff(removed: string[], added: string[]): DiffLine[] {
  if (removed.length === 0) {
    return added.map((text) => ({ kind: "added" as const, text }));
  }
  if (added.length === 0) {
    return removed.map((text) => ({ kind: "removed" as const, text }));
  }

  // Build LCS table
  const m = removed.length;
  const n = added.length;
  const lcs: number[][] = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (removed[i - 1] === added[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  // Backtrack to build the diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && removed[i - 1] === added[j - 1]) {
      result.unshift({ kind: "unchanged", text: removed[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      result.unshift({ kind: "added", text: added[j - 1] });
      j--;
    } else if (i > 0) {
      result.unshift({ kind: "removed", text: removed[i - 1] });
      i--;
    }
  }

  return result;
}

/**
 * Split a replaced or inserted span into lines.
 *
 * A span ending in a newline splits with an empty final element that is the boundary
 * rather than a line of its own; printing it as a blank +/- row reads as content that
 * is not there. Neither side is a whole file, so there is nothing else this could mean.
 */
function lines(text: string): string[] {
  if (text === "") return [];
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

/** The change from `before` to `after`. Either side may be empty: a created file has
 *  nothing removed, and a file emptied by an edit has nothing added. */
export function describeChange(before: string, after: string): Change {
  // Identical text is not a change, and without a diff to notice that, it would show as
  // every line removed and the same lines added straight back. write_file rewriting a
  // file with its own contents is the case that reaches this.
  if (before === after) return { removed: [], added: [] };
  return { removed: lines(before), added: lines(after) };
}

/** "+12 -3", the shape a summary line wants. Always the true totals, whatever the
 *  display ends up showing. */
export function changeStat(c: Change): string {
  return `+${c.added.length} -${c.removed.length}`;
}

/**
 * A change painted for the terminal: removals in red, additions in green, unchanged
 * lines in white, under a bold label naming what ran, e.g. "edit_file src/agent.ts:42".
 *
 * `maxLines` bounds the body — a wholesale rewrite belongs in the file, not scrolled
 * past in the terminal. Removals are trimmed first: what a file now says matters more
 * than what it used to.
 */
export function paintChange(label: string, c: Change, maxLines = 200): string {
  if (!c.removed.length && !c.added.length) return `  ${BOLD}${label}${RESET} ${DIM}(no change)${RESET}`;

  // Compute the diff to identify unchanged lines
  const diffLines = computeDiff(c.removed, c.added);

  // Apply maxLines cap: count by kind, trim removals first
  if (diffLines.length > maxLines) {
    const over = diffLines.length - maxLines;
    const removedCount = diffLines.filter((l) => l.kind === "removed").length;
    const cutRemoved = Math.min(over, removedCount);
    
    let cut = 0;
    const trimmed: DiffLine[] = [];
    
    for (const line of diffLines) {
      if (line.kind === "removed" && cut < cutRemoved) {
        cut++;
        continue;
      }
      if (trimmed.length >= maxLines) break;
      trimmed.push(line);
    }
    
    const head = `  ${BOLD}${label}${RESET} ${GREEN}+${c.added.length}${RESET} ${RED}-${c.removed.length}${RESET}`;
    const body = trimmed.map((l) => {
      if (l.kind === "removed") return `  ${RED}-${l.text}${RESET}`;
      if (l.kind === "added") return `  ${GREEN}+${l.text}${RESET}`;
      return `  ${l.text}`;
    });
    body.push(`  ${DIM}… ${diffLines.length - trimmed.length} more lines not shown${RESET}`);
    return [head, ...body].join("\n");
  }

  const head = `  ${BOLD}${label}${RESET} ${GREEN}+${c.added.length}${RESET} ${RED}-${c.removed.length}${RESET}`;
  const body = diffLines.map((l) => {
    if (l.kind === "removed") return `  ${RED}-${l.text}${RESET}`;
    if (l.kind === "added") return `  ${GREEN}+${l.text}${RESET}`;
    return `  ${l.text}`;
  });
  return [head, ...body].join("\n");
}
