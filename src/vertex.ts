/**
 * Claude on Vertex AI.
 *
 * NodeLLM 1.17 ships no Vertex provider, and none of its knobs can fake one: its
 * Anthropic client posts to `${baseUrl}/messages` with the model in the JSON body and
 * the key in an `x-api-key` header, whereas Vertex puts the model in the URL, wants
 * `anthropic_version` in the body, and authenticates with an OAuth bearer token. Three
 * mismatches, all inside the request builder — so this is a real provider, handed to
 * `createLLM({ provider })` as an instance.
 *
 * Only the message shapes this agent actually produces are converted: text, tool_use
 * and tool_result. There is no image or PDF path because no tool in `tools.ts` returns
 * one; anything else would be dead code written against an untested API.
 */
import { spawnSync } from "node:child_process";

import {
  BaseProvider,
  ModelRegistry,
  fetchWithTimeout,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type ProviderCapabilities,
  type ToolCall,
  type Usage,
} from "@node-llm/core";

/** The only value Vertex accepts, and it is required on every request. */
const ANTHROPIC_VERSION = "vertex-2023-10-16";
const DEFAULT_MAX_TOKENS = 8_192;

export interface VertexOptions {
  project: string;
  region: string;
  token: string;
}

/**
 * A Google access token, however the environment can produce one.
 *
 * Vertex tokens expire in about an hour, which for a long-lived process would mean
 * refresh logic. This agent does one turn per invocation, so minting a fresh token per
 * run costs one subprocess and removes the problem entirely.
 */
export function vertexAccessToken(): string {
  const fromEnv = process.env.VERTEX_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN;
  if (fromEnv) return fromEnv.trim();

  const r = spawnSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : (r.stderr || "").trim().split("\n").pop();
    throw new Error(
      `Could not get a Vertex access token: ${why || "gcloud exited non-zero"}.\n` +
        `Run "gcloud auth application-default login", or set VERTEX_ACCESS_TOKEN yourself.`,
    );
  }
  return r.stdout.trim();
}

/** Anthropic content blocks, in the subset this agent sends and receives. */
type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface VertexMessage {
  role: "user" | "assistant";
  content: string | Block[];
}

/** The system prompt is a top-level field on Anthropic requests, not a message. */
function systemPrompt(messages: readonly Message[]): string | undefined {
  const parts = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => String(m.content ?? ""))
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

function convert(msg: Message): VertexMessage {
  // A tool result is a user-role message carrying a tool_result block.
  if (msg.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: String(msg.tool_call_id),
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          ...(msg.isError && { is_error: true }),
        },
      ],
    };
  }

  if (msg.role === "assistant" && msg.tool_calls?.length) {
    const blocks: Block[] = [];
    const text = String(msg.content ?? "");
    if (text) blocks.push({ type: "text", text });
    for (const call of msg.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments || "{}") as unknown,
      });
    }
    return { role: "assistant", content: blocks };
  }

  return { role: msg.role === "user" ? "user" : "assistant", content: String(msg.content ?? "") };
}

/**
 * Consecutive same-role messages must be merged: the API rejects two user turns in a
 * row, which is exactly what a parallel tool call produces (one tool_result message per
 * call, each converted to a user turn).
 */
function formatMessages(messages: readonly Message[]): VertexMessage[] {
  const out: VertexMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") continue;
    const next = convert(msg);
    const last = out[out.length - 1];
    if (last && last.role === next.role) {
      const before: Block[] = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
      const after: Block[] = Array.isArray(next.content) ? next.content : [{ type: "text", text: next.content }];
      last.content = [...before, ...after];
    } else {
      out.push(next);
    }
  }
  return out;
}

export class VertexProvider extends BaseProvider {
  private readonly opts: VertexOptions;

  override capabilities: ProviderCapabilities = {
    supportsVision: () => true,
    supportsTools: () => true,
    supportsStructuredOutput: () => true,
    supportsEmbeddings: () => false,
    supportsImageGeneration: () => false,
    supportsTranscription: () => false,
    supportsModeration: () => false,
    supportsReasoning: () => true,
    supportsDeveloperRole: () => true,
    supportsToolChoice: () => true,
    getContextWindow: (model) => ModelRegistry.getContextWindow(model, "vertex") ?? null,
  };

  constructor(opts: VertexOptions) {
    super();
    this.opts = opts;
  }

  /** The `global` region has no host prefix; every other region does. */
  apiBase(): string {
    const { project, region } = this.opts;
    const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${project}/locations/${region}/publishers/anthropic/models`;
  }

  headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.token}`,
      "Content-Type": "application/json",
    };
  }

  protected providerName(): string {
    // Lowercase, because this is what ModelRegistry lookups are keyed on elsewhere.
    return "vertex";
  }

  override defaultModel(_feature?: string): string {
    return "claude-sonnet-4-5@20250929";
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const {
      model,
      messages,
      tools,
      tool_choice,
      max_tokens,
      temperature,
      thinking,
      headers: extraHeaders,
      requestTimeout,
      // Dropped rather than forwarded: Vertex takes the model from the URL, and the
      // OpenAI-shaped keys below have no Anthropic equivalent.
      parallel_tool_calls: _parallel,
      response_format: _format,
      prediction: _prediction,
      // Everything else — notably cache_control, which Vertex supports exactly as the
      // first-party API does — is spread into the body untouched.
      ...rest
    } = request;

    const body: Record<string, unknown> = {
      anthropic_version: ANTHROPIC_VERSION,
      messages: formatMessages(messages),
      max_tokens: max_tokens || DEFAULT_MAX_TOKENS,
      stream: false,
      ...rest,
    };
    const system = systemPrompt(messages);
    if (system) body.system = system;
    if (temperature !== undefined) body.temperature = temperature;
    if (thinking?.budget) {
      body.thinking = { type: "enabled", budget_tokens: thinking.budget };
      if (!max_tokens) body.max_tokens = Math.max(DEFAULT_MAX_TOKENS, thinking.budget + 1024);
    }
    if (tools?.length && tool_choice !== "none") {
      body.tools = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
      if (tool_choice === "auto") body.tool_choice = { type: "auto" };
      else if (tool_choice === "required") body.tool_choice = { type: "any" };
      else if (typeof tool_choice === "string") body.tool_choice = { type: "tool", name: tool_choice };
      else if (tool_choice) body.tool_choice = { type: "tool", name: tool_choice.function.name };
    }

    // :rawPredict is the non-streaming counterpart of /v1/messages. The model id, with
    // its @version suffix, is a path segment here rather than a body field.
    const url = `${this.apiBase()}/${model}:rawPredict`;
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { ...this.headers(), ...extraHeaders },
        body: JSON.stringify(body),
      },
      requestTimeout,
    );

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000);
      throw new Error(`Vertex ${response.status} ${response.statusText} for ${model}: ${detail}`);
    }

    const json = (await response.json()) as {
      content?: Block[];
      stop_reason?: string | null;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };

    let content: string | null = null;
    let thinkingResult: { text?: string; signature?: string } | undefined;
    const toolCalls: ToolCall[] = [];
    for (const block of json.content ?? []) {
      if (block.type === "text") {
        content = (content ?? "") + block.text;
      } else if (block.type === "thinking") {
        thinkingResult ??= { text: "" };
        if (block.thinking) thinkingResult.text = (thinkingResult.text ?? "") + block.thinking;
        if (block.signature) thinkingResult.signature = block.signature;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      }
    }

    const u = json.usage;
    const usage: Usage | undefined = u && {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      cached_tokens: u.cache_read_input_tokens,
      cache_creation_tokens: u.cache_creation_input_tokens,
    };

    return {
      content,
      ...(thinkingResult && { thinking: thinkingResult }),
      ...(toolCalls.length && { tool_calls: toolCalls }),
      usage,
      finish_reason: json.stop_reason ?? null,
    };
  }
}
