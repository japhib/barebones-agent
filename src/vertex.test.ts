import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { ChatRequest, Message } from "@node-llm/core";

import { VertexProvider } from "./vertex.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Runs one chat() against a stubbed fetch and hands back what went over the wire. */
async function capture(
  request: Partial<ChatRequest> & { messages: Message[] },
  reply: unknown = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
): Promise<{ sent: Captured; result: Awaited<ReturnType<VertexProvider["chat"]>> }> {
  const original = globalThis.fetch;
  let sent: Captured | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = {
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new VertexProvider({ project: "acme-dev", region: "us-east5", token: "tok-123" });
  try {
    const result = await provider.chat({ model: "claude-sonnet-4-5@20250929", ...request });
    assert.ok(sent, "fetch was never called");
    return { sent: sent as Captured, result };
  } finally {
    globalThis.fetch = original;
  }
}

describe("VertexProvider request", () => {
  test("puts the model in the URL and the version in the body", async () => {
    const { sent } = await capture({ messages: [{ role: "user", content: "hello" }] });

    assert.equal(
      sent.url,
      "https://us-east5-aiplatform.googleapis.com/v1/projects/acme-dev/locations/us-east5" +
        "/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict",
    );
    // The model is a path segment here, not a body field — sending both is an error.
    assert.equal(sent.body.model, undefined);
    assert.equal(sent.body.anthropic_version, "vertex-2023-10-16");
    assert.equal(sent.headers.Authorization, "Bearer tok-123");
  });

  test("the global region drops the host prefix", async () => {
    const provider = new VertexProvider({ project: "acme-dev", region: "global", token: "t" });
    assert.equal(
      provider.apiBase(),
      "https://aiplatform.googleapis.com/v1/projects/acme-dev/locations/global/publishers/anthropic/models",
    );
  });

  test("lifts system messages out of the message list", async () => {
    const { sent } = await capture({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ],
    });

    assert.equal(sent.body.system, "be terse");
    assert.deepEqual(sent.body.messages, [{ role: "user", content: "hello" }]);
  });

  test("passes cache_control through untouched", async () => {
    const { sent } = await capture({
      messages: [{ role: "user", content: "hello" }],
      cache_control: { type: "ephemeral", ttl: "1h" },
    } as Partial<ChatRequest> & { messages: Message[] });

    assert.deepEqual(sent.body.cache_control, { type: "ephemeral", ttl: "1h" });
  });

  test("merges parallel tool results into a single user turn", async () => {
    // Two tool_result messages in a row become two user turns unless they are merged,
    // and the API rejects consecutive same-role messages.
    const { sent } = await capture({
      messages: [
        { role: "user", content: "read both" },
        {
          role: "assistant",
          content: "reading",
          tool_calls: [
            { id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
            { id: "t2", type: "function", function: { name: "read_file", arguments: '{"path":"b"}' } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "contents of a" },
        { role: "tool", tool_call_id: "t2", content: "boom", isError: true },
      ],
    });

    assert.deepEqual(sent.body.messages, [
      { role: "user", content: "read both" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
          { type: "tool_use", id: "t2", name: "read_file", input: { path: "b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "contents of a" },
          { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
        ],
      },
    ]);
  });

  test("converts tool definitions to Anthropic's input_schema shape", async () => {
    const { sent } = await capture({
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          function: { name: "run_bash", description: "run a command", parameters: { type: "object" } },
        },
      ],
      tool_choice: "auto",
    });

    assert.deepEqual(sent.body.tools, [
      { name: "run_bash", description: "run a command", input_schema: { type: "object" } },
    ]);
    assert.deepEqual(sent.body.tool_choice, { type: "auto" });
  });
});

describe("VertexProvider response", () => {
  test("splits content blocks into text and tool calls, and maps cache usage", async () => {
    const { result } = await capture(
      { messages: [{ role: "user", content: "go" }] },
      {
        content: [
          { type: "text", text: "looking now" },
          { type: "tool_use", id: "t9", name: "list_tree", input: { path: "src" } },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 56,
        },
      },
    );

    assert.equal(result.content, "looking now");
    assert.deepEqual(result.tool_calls, [
      { id: "t9", type: "function", function: { name: "list_tree", arguments: '{"path":"src"}' } },
    ]);
    assert.equal(result.finish_reason, "tool_use");
    // The three input categories the agent prices separately must survive the trip.
    assert.equal(result.usage?.cached_tokens, 900);
    assert.equal(result.usage?.cache_creation_tokens, 56);
    assert.equal(result.usage?.total_tokens, 46);
  });

  test("reports a failed request with its status and body", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":{"message":"permission denied"}}', {
        status: 403,
        statusText: "Forbidden",
      })) as unknown as typeof fetch;
    const provider = new VertexProvider({ project: "p", region: "us-east5", token: "t" });
    try {
      await assert.rejects(
        provider.chat({ model: "claude-sonnet-4-5@20250929", messages: [{ role: "user", content: "x" }] }),
        /Vertex 403 Forbidden .*permission denied/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
