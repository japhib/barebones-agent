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
 * A change painted for the terminal: removals in red, additions in green, under a bold
 * label naming what ran, e.g. "edit_file src/agent.ts:42".
 *
 * `maxLines` bounds the body — a wholesale rewrite belongs in the file, not scrolled
 * past in the terminal. Removals are trimmed first: what a file now says matters more
 * than what it used to.
 */
export function paintChange(label: string, c: Change, maxLines = 200): string {
  if (!c.removed.length && !c.added.length) return `  ${BOLD}${label}${RESET} ${DIM}(no change)${RESET}`;

  const over = Math.max(0, c.removed.length + c.added.length - maxLines);
  const cutRemoved = Math.min(over, c.removed.length);
  const removed = c.removed.slice(0, c.removed.length - cutRemoved);
  const added = c.added.slice(0, c.added.length - (over - cutRemoved));

  const head = `  ${BOLD}${label}${RESET} ${GREEN}+${c.added.length}${RESET} ${RED}-${c.removed.length}${RESET}`;
  const body = [
    ...removed.map((l) => `  ${RED}-${l}${RESET}`),
    ...added.map((l) => `  ${GREEN}+${l}${RESET}`),
  ];
  if (over) body.push(`  ${DIM}… ${over} more lines not shown${RESET}`);
  return [head, ...body].join("\n");
}
