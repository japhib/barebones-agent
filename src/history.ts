/**
 * Keeping a saved history sendable.
 *
 * A turn that ends anywhere other than a clean stop leaves the message list in a shape
 * the API refuses, and the session becomes unresumable. This is the repair, applied on
 * the way in and on the way out.
 */
import type { Message } from "@node-llm/core";

/**
 * Make a history safe to send again.
 *
 * A turn that ends anywhere other than a clean stop — the user interrupting it, the
 * request timing out, `maxToolCalls` tripping — can leave an assistant message whose
 * tool_calls were never answered. NodeLLM's Anthropic conversion does no pairing check
 * and re-sends it verbatim, and the API rejects that with "tool_use ids were found
 * without tool_result blocks immediately after", which makes the session unresumable.
 *
 * The repair synthesises the missing results rather than truncating back to the last
 * clean stop. The dangling calls are the most recent work the agent did, and after an
 * interruption they are exactly what the user is about to ask about; cutting them would
 * throw away the answer.
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
