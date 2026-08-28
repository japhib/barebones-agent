/**
 * Live activity on stderr.
 *
 * stdout stays exactly as it was — the finished answer, buffered, rendered once as
 * Markdown — so piping into glow or a file is unaffected. Everything here is stderr,
 * and on a TTY it is erased when the turn ends, leaving only the permanent lines.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[2K";

export class Progress {
  private timer: ReturnType<typeof setInterval> | null = null;
  private label = "";
  private since = 0;
  private frame = 0;
  private painted = false;
  private readonly live: boolean;

  constructor(private readonly enabled: boolean) {
    // Animate only on a real terminal; redirected stderr gets plain one-off lines.
    this.live = enabled && process.stderr.isTTY === true;
  }

  private erase(): void {
    if (!this.painted) return;
    process.stderr.write(CLEAR_LINE);
    this.painted = false;
  }

  private paint(): void {
    if (!this.live || !this.label) return;
    const secs = Math.round((Date.now() - this.since) / 1000);
    const spin = FRAMES[this.frame++ % FRAMES.length];
    const elapsed = secs >= 2 ? ` ${secs}s` : "";
    process.stderr.write(`${CLEAR_LINE}${DIM}${spin} ${this.label}${elapsed}${RESET}`);
    this.painted = true;
  }

  /** Replace the transient status, e.g. "thinking" or a running tool name. */
  step(label: string): void {
    if (!this.enabled || label === this.label) return; // don't restate the same phase
    this.label = label;
    this.since = Date.now();
    // Off a TTY there is nothing to animate, and echoing every phase change just
    // interleaves noise with the lines that carry actual information.
    if (!this.live) return;
    if (!this.timer) {
      const t = setInterval(() => this.paint(), 100);
      t.unref(); // never hold the process open for a spinner
      this.timer = t;
    }
    this.paint();
  }

  /** Write a line that stays on screen, above the spinner. */
  line(text: string): void {
    if (!this.enabled) return;
    this.erase();
    process.stderr.write(`${text}\n`);
    this.paint();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.erase();
    this.label = "";
  }
}

export const dim = (s: string): string => `${DIM}${s}${RESET}`;
