/**
 * History compaction.
 *
 * NodeLLM has no server-side context management, so this is ours. The whole reason
 * this file exists separately is the cut point: slicing between an assistant message
 * that carries tool_calls and the tool messages answering them leaves a dangling call,
 * and the API rejects the request. Every cut here lands on a turn boundary instead.
 */
import type { Message, NodeLLMCore } from "@node-llm/core";

import type { Usage } from "./context.js";
import { zeroUsage } from "./context.js";

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

/** The summariser is a real billed request, so it is reported rather than hidden. */
export interface CompactResult {
  messages: Message[];
  usage: Usage;
  model: string;
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

/**
 * Make a history safe to send again.
 *
 * A turn that ends anywhere other than a clean stop — the user interrupting it, the
 * request timing out, `maxToolCalls` tripping — can leave an assistant message whose
 * tool_calls were never answered. NodeLLM's Anthropic conversion does no pairing check
 * and re-sends it verbatim, and the API rejects that with "tool_use ids were found
 * without tool_result blocks immediately after", which makes the session unresumable.
 *
 * The repair synthesises the missing results rather than cutting back to a safe boundary
 * the way compaction does. The dangling calls are the most recent work the agent did, and
 * after an interruption they are exactly what the user is about to ask about; truncating
 * would throw away the answer.
 */
export function repairDangling(messages: readonly Message[]): Message[] {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);
  }

  const out: Message[] = [];
  for (const m of messages) {
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    for (const call of m.tool_calls) {
      if (answered.has(call.id)) continue;
      answered.add(call.id); // a duplicated id must not produce two results
      out.push({
        role: "tool",
        tool_call_id: call.id,
        content: "Interrupted: this tool never ran, so it produced no result.",
        isError: true,
      });
    }
  }

  // An assistant message with neither text nor tool calls converts to an empty content
  // array, which the API rejects just as firmly as a dangling call.
  const last = out[out.length - 1];
  if (last?.role === "assistant" && !last.tool_calls?.length && !String(last.content ?? "").trim()) {
    out.pop();
  }
  return out;
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

export async function compactHistory(messages: Message[], opts: CompactOptions): Promise<CompactResult> {
  const [head, tail] = summarisable(messages, opts.keepRecentTurns);
  const span = messages.slice(head, tail);
  const usage = zeroUsage();
  if (span.length < 2) return { messages, usage, model: SUMMARY_MODEL }; // not worth the round trip

  const res = await opts.llm.chat(SUMMARY_MODEL).withInstructions(SUMMARY_PROMPT).ask(transcribe(span));

  usage.input = res.usage.input_tokens ?? 0;
  usage.cacheRead = res.usage.cached_tokens ?? 0;
  usage.cacheWrite = res.usage.cache_creation_tokens ?? 0;
  usage.output = res.usage.output_tokens ?? 0;
  usage.requests = 1;

  return {
    messages: [
      ...messages.slice(0, head),
      { role: "user", content: `## Summary of earlier conversation\n\n${res.content.trim()}` },
      ...messages.slice(tail),
    ],
    usage,
    model: SUMMARY_MODEL,
  };
}
