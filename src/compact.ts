/**
 * History compaction.
 *
 * NodeLLM has no server-side context management, so this is ours. The whole reason
 * this file exists separately is the cut point: slicing between an assistant message
 * that carries tool_calls and the tool messages answering them leaves a dangling call,
 * and the API rejects the request. Every cut here lands on a turn boundary instead.
 */
import type { Message, NodeLLMCore } from "@node-llm/core";

const SUMMARY_MODEL = "claude-haiku-4-5";
const MAX_CHARS_PER_MESSAGE = 4000;

const SUMMARY_PROMPT = `You are compacting the earlier part of a coding session so it can
be dropped from the context window. Write a dense brief, under 500 words, covering:

- what was accomplished, and what was tried and abandoned
- every file created, modified or deleted, and what changed in each
- decisions made and the reasoning behind them
- anything still open, unresolved, or explicitly deferred

Write it as notes for the agent that continues this work. Be specific about file paths
and identifiers. Do not editorialise and do not add a preamble.`;

export interface CompactOptions {
  llm: NodeLLMCore;
  keepRecentTurns: number;
}

/**
 * Indices at which the history can be split without orphaning a tool call.
 * A boundary of `i` means `messages.slice(0, i)` is self-consistent.
 */
export function safeBoundaries(messages: readonly Message[]): number[] {
  const boundaries: number[] = [];
  const awaiting = new Set<string>();
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const call of m.tool_calls) awaiting.add(call.id);
    }
    if (m.role === "tool" && m.tool_call_id) awaiting.delete(m.tool_call_id);
    if (awaiting.size === 0) boundaries.push(i + 1);
  });
  return boundaries;
}

function summarisable(messages: readonly Message[], keepRecentTurns: number): [number, number] {
  // Keep everything up to and including the first user message: that is the original task.
  const firstUser = messages.findIndex((m) => m.role === "user");
  const head = firstUser === -1 ? 0 : firstUser + 1;

  // Keep the last N user-initiated turns verbatim.
  const userTurns = messages.reduce<number[]>((acc, m, i) => (m.role === "user" ? [...acc, i] : acc), []);
  const wanted = userTurns.length > keepRecentTurns ? userTurns[userTurns.length - keepRecentTurns]! : messages.length;

  // Snap backwards to the nearest boundary that does not orphan a tool call.
  const candidates = safeBoundaries(messages).filter((b) => b >= head && b <= wanted);
  const tail = candidates.length ? Math.max(...candidates) : head;
  return [head, tail];
}

function transcribe(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      const calls = m.tool_calls?.length ? ` (called ${m.tool_calls.map((c) => c.function.name).join(", ")})` : "";
      const body = String(m.content ?? "").slice(0, MAX_CHARS_PER_MESSAGE);
      return `[${m.role}]${calls}\n${body}`;
    })
    .join("\n\n");
}

export async function compactHistory(messages: Message[], opts: CompactOptions): Promise<Message[]> {
  const [head, tail] = summarisable(messages, opts.keepRecentTurns);
  const span = messages.slice(head, tail);
  if (span.length < 2) return messages; // nothing worth the round trip

  const res = await opts.llm.chat(SUMMARY_MODEL).withInstructions(SUMMARY_PROMPT).ask(transcribe(span));

  return [
    ...messages.slice(0, head),
    { role: "user", content: `## Summary of earlier conversation\n\n${res.content.trim()}` },
    ...messages.slice(tail),
  ];
}
