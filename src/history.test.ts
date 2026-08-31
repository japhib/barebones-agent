import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Message, ToolCall } from "@node-llm/core";

import { repairDangling } from "./history.js";

const call = (id: string, name: string): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
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
