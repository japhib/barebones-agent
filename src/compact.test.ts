import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Message, NodeLLMCore, ToolCall } from "@node-llm/core";

import { compactHistory, repairDangling, safeBoundaries } from "./compact.js";
import { zeroUsage } from "./context.js";

const call = (id: string, name: string): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
});

// ---------------------------------------------------------------- safeBoundaries

describe("safeBoundaries", () => {
  test("returns a boundary after every clean stop", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
      { role: "user", content: "again" },
    ];
    // Every message lands on an empty awaiting set, so every position is a boundary.
    assert.deepEqual(safeBoundaries(messages), [1, 2, 3]);
  });

  test("does not allow a cut that orphaning a tool call would produce", () => {
    const messages: Message[] = [
      { role: "user", content: "read it" },
      { role: "assistant", content: "reading", tool_calls: [call("t1", "read_file")] },
      { role: "tool", tool_call_id: "t1", content: "contents" },
    ];
    // Index 2 would separate the assistant from its own tool result, so it is skipped.
    assert.deepEqual(safeBoundaries(messages), [1, 3]);
  });

  test("a boundary reopens once every outstanding parallel call is answered", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "both",
        tool_calls: [call("t1", "read_file"), call("t2", "read_file")],
      },
      { role: "tool", tool_call_id: "t1", content: "a" },
      // t2 still owed: still no boundary here.
      { role: "tool", tool_call_id: "t2", content: "b" },
    ];
    const bounds = safeBoundaries(messages);
    assert.ok(!bounds.includes(3)); // right after t1, while t2 is still owed
    assert.ok(bounds.includes(4)); // once t2 is answered
  });
});

// ---------------------------------------------------------------- repairDangling

describe("repairDangling", () => {
  test("answers unanswered tool calls and drops a trailing empty assistant", () => {
    const history: Message[] = [
      { role: "user", content: "refactor the parser" },
      {
        role: "assistant",
        content: "reading both files",
        tool_calls: [call("t1", "read_file"), call("t2", "read_file")],
      },
      { role: "tool", tool_call_id: "t1", content: "export function parse() {}" },
      // What an interrupted turn leaves behind: t2 never ran, and the reply came back blank.
      { role: "assistant", content: "   " },
    ];

    const repaired = repairDangling(history);

    // The prompt and the call that made it survive untouched...
    assert.deepEqual(repaired.slice(0, 2), history.slice(0, 2));
    // ...a synthetic result is inserted for t2 alone, right after the message that
    // called it, so both results still follow the assistant message the API pairs them
    // against...
    assert.deepEqual(repaired[2], {
      role: "tool",
      tool_call_id: "t2",
      content: "Interrupted: this tool never ran, so it produced no result.",
      isError: true,
    });
    // ...t1 already had a real answer and is not duplicated...
    assert.deepEqual(repaired[3], history[2]);
    // ...and the contentless assistant message, which the API rejects, is gone.
    assert.equal(repaired.length, 4);

    // The input is left alone: the transcript keeps the full record.
    assert.equal(history.length, 4);
  });

  test("leaves a fully-answered round untouched", () => {
    const history: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "ok", tool_calls: [call("t1", "read_file")] },
      { role: "tool", tool_call_id: "t1", content: "done" },
    ];
    assert.deepEqual(repairDangling(history), history);
  });

  test("produces exactly one synthetic result per id even if it appears twice", () => {
    // A duplicated id is pathological, but must not become two dangling results.
    const history: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "x",
        tool_calls: [call("t1", "read_file"), call("t1", "read_file")],
      },
    ];
    const repaired = repairDangling(history);
    const results = repaired.filter((m) => m.role === "tool" && m.tool_call_id === "t1");
    assert.equal(results.length, 1);
  });

  test("a non-tool-capable trailing assistant is dropped, a real one is kept", () => {
    const blank = repairDangling([{ role: "user", content: "hi" }, { role: "assistant", content: "  " }]);
    assert.equal(blank.length, 1);
    assert.equal(blank[0]!.role, "user");

    const real = repairDangling([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
    assert.equal(real.length, 2);
  });
});

// ---------------------------------------------------------------- compactHistory

describe("compactHistory", () => {
  /** A NodeLLM-shaped stub that records the request then returns a canned reply. */
  function fakeLLM(reply: { content: string; usage?: Record<string, number> }): {
    llm: NodeLLMCore;
    asked: { model: string; prompt: string }[];
  } {
    const asked: { model: string; prompt: string }[] = [];
    const llm = {
      chat: (model: string) => ({
        withInstructions: (_sys: string) => ({
          ask: async (transcript: string) => {
            asked.push({ model, prompt: transcript });
            return {
              content: reply.content,
              usage: {
                input_tokens: reply.usage?.input_tokens ?? 0,
                cached_tokens: reply.usage?.cached_tokens ?? 0,
                cache_creation_tokens: reply.usage?.cache_creation_tokens ?? 0,
                output_tokens: reply.usage?.output_tokens ?? 0,
              },
            };
          },
        }),
      }),
    };
    return { llm: llm as unknown as NodeLLMCore, asked };
  }

  test("summarises the middle span and keeps the head and recent turns verbatim", async () => {
    const messages: Message[] = [
      { role: "user", content: "original task" },
      { role: "assistant", content: "worked on read_file" },
      { role: "user", content: "now fix the bug" },
      { role: "assistant", content: "fixed it in src/a.ts" },
      { role: "user", content: "did you test it" },
    ];
    const { llm, asked } = fakeLLM({
      content: "BRIEF",
      usage: { input_tokens: 100, cached_tokens: 10, cache_creation_tokens: 5, output_tokens: 20 },
    });

    const res = await compactHistory(messages, { llm, keepRecentTurns: 1, summaryModel: "claude-haiku-4-5" });

    // The summariser was asked on the cheap model, against the middle of the history
    // (the original task itself is the head and is retained verbatim, never summarised).
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.model, "claude-haiku-4-5");
    assert.match(asked[0]!.prompt, /worked on read_file/);
    assert.match(asked[0]!.prompt, /fixed it in src\/a\.ts/);
    assert.doesNotMatch(asked[0]!.prompt, /original task/);

    assert.equal(res.model, "claude-haiku-4-5");
    assert.deepEqual(res.messages[0], messages[0]);
    assert.equal(res.messages[1]!.role, "user");
    assert.match(String(res.messages[1]!.content), /^## Summary of earlier conversation\n\nBRIEF$/);
    // The recent turn (asked to be kept verbatim) survives after the summary.
    assert.deepEqual(res.messages.slice(2), messages.slice(4));

    // The billed request is reported on the returned usage.
    assert.equal(res.usage.input, 100);
    assert.equal(res.usage.cacheRead, 10);
    assert.equal(res.usage.cacheWrite, 5);
    assert.equal(res.usage.output, 20);
    assert.equal(res.usage.requests, 1);
  });

  test("skips the round trip when there is nothing worth summarising", async () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "a1" },
    ];
    const { llm, asked } = fakeLLM({ content: "should never be used" });

    const res = await compactHistory(messages, { llm, keepRecentTurns: 1, summaryModel: "m" });

    assert.equal(asked.length, 0); // no model call
    assert.deepEqual(res.messages, messages);
    assert.deepEqual(res.usage, zeroUsage());
    assert.equal(res.model, "m");
  });

  test("does not call the summariser when the tail is the entire history", async () => {
    const messages: Message[] = [{ role: "user", content: "task" }];
    const { llm, asked } = fakeLLM({ content: "" });
    const res = await compactHistory(messages, { llm, keepRecentTurns: 4, summaryModel: "m" });
    assert.equal(asked.length, 0);
    assert.equal(res.messages.length, 1);
    assert.deepEqual(res.usage, zeroUsage());
  });

  test("a cut never lands between an assistant and its own tool result", async () => {
    const messages: Message[] = [
      { role: "user", content: "read all" },
      {
        role: "assistant",
        content: "reading",
        tool_calls: [call("t1", "read_file"), call("t2", "read_file")],
      },
      { role: "tool", tool_call_id: "t1", content: "a" },
      { role: "tool", tool_call_id: "t2", content: "b" },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "done" },
    ];
    const { llm, asked } = fakeLLM({ content: "S", usage: { input_tokens: 1 } });
    const res = await compactHistory(messages, { llm, keepRecentTurns: 1, summaryModel: "m" });

    // The cut for the summary must land after the whole tool round (messages 1-3), never
    // between the "reading" assistant and its results. So the head is verbatim, then the
    // summary, then the trailing "thanks"/"done" turns kept in full.
    const summaryIndex = res.messages.findIndex((m) => String(m.content ?? "").startsWith("## Summary"));
    assert.equal(summaryIndex, 1);
    assert.deepEqual(res.messages[0], messages[0]);
    assert.deepEqual(res.messages.slice(2), messages.slice(4)); // "thanks" + "done", untouched
    assert.equal(asked.length, 1);
  });
});
