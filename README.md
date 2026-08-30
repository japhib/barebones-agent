# barebones-agent

A coding agent that does **one turn of work per invocation**, then exits.

There is no input loop, no streaming renderer, no TUI. Whenever the agent needs you —
a follow-up prompt, an answer to a question, approval to run a command — it writes the
request into a markdown transcript, saves the session, and exits with the command to
re-invoke. The transcript is the mailbox; your editor is the UI.

One runtime dependency ([`@node-llm/core`](https://nodellm.dev)), bundled into a single
self-contained `dist/agent.js`.

## Setup

```sh
brew install ripgrep          # required
brew install glow             # optional, for rendered output
npm install && npm run build
export ANTHROPIC_API_KEY=...
export TAVILY_API_KEY=...     # optional, enables web_search
```

Anthropic is the default; DeepSeek and Vertex AI work too — see [Providers](#providers).

Optionally `npm link` to get `bba` on your PATH; otherwise call `node dist/agent.js`.

## Usage

```sh
bba "explain what this project does"    # start a session
bba -s <id> "now add a --version flag"  # continue it
bba -s <id> -e                          # edit the transcript, then run what you wrote
bba -s <id>                             # run whatever is under the last "## You"
bba -s <id> -f prompt.md                # take the prompt from a file
bba -l                                  # list this directory's sessions
```

Every run prints the exact command to continue:

```
↻  bba -s 7f3a2c91 -e
```

| Flag | |
|---|---|
| `--plan` / `--act` | Switch mode; persists in the session |
| `--provider <name>` | `anthropic` (default), `deepseek` or `vertex`; pinned to the session |
| `--approve` | Run the pending shell command once (non-interactive fallback) |
| `--always-approve` | Run it, and never ask for that exact command again |
| `--decline [reason]` | Refuse it; with no reason, hands control back to you |
| `--compact` | Compact the history now |
| `--timeout <s>` | Per-request limit for the model API (default 600s) |
| `--bash-timeout <s>` | Limit for a single `run_bash` command (default 120s) |
| `--quiet` | No progress output |
| `--usage` | Report the session's token spend and exit |
| `-l` / `--sessions` | List the sessions saved in this directory, newest first, each with the command to resume it |
| `Ctrl-C` | Stop the turn and save it; twice cuts a request in flight |
| `--model <id>` `--editor <cmd>` `--compact-at <n>` `--verbose` `--help` | |

### Finding an old session

Sessions live in `.agent/` beside the project, so `bba -l` lists exactly the ones
belonging to the directory you are standing in — newest first, with the opening prompt
as the label and the resume command spelled out:

```
2 sessions under .agent/

  7f3a2c91  4m ago · act · claude-opus-5 · 3 turns · $0.4231
  add a --version flag that prints the package version and exits
  ↻  bba -s 7f3a2c91 -e

  aa11bb22  2d ago · plan · claude-sonnet-5 · 1 turn · $0.0120  ⚠ awaiting approval
  run the test suite and fix whatever fails
  ↻  bba -s aa11bb22 --approve
```

A session halted mid-turn is flagged, and its command is the one that unblocks it
(`--approve` for a pending shell command) rather than `-e`.

### Interrupting a turn

`Ctrl-C` stops a turn **without losing what it already did**. Every completed tool result
is kept, so you can ask about them:

```
  read_file src/agent.ts
  search_code pendingBash
^C
⏸  stopping at the next tool call — ^C again to cut the request now

## ⏸ Interrupted

_Stopped after 7 tool calls._

- `list_tree src`
- `read_file src/agent.ts`
- `search_code pendingBash`

↻  bba -s 7f3a2c91 -e
```

Then `bba -s <id> -e`, type *"what were you doing? explain these tool calls"*, and it
answers from the results it already has — and **stops there**. It never resumes the
interrupted task on its own; that takes another prompt from you.

The list matters because the progress display is stderr-only and erases itself, so the
transcript is the only durable record of the calls you stopped to ask about.

**Two presses.** `ask()` is not streaming, so while the model is composing a reply there
is no safe point to stop at. The first press halts at the next tool call — instant while
tools are running, otherwise it waits for the reply in flight. The second press cuts that
request; only the uncompleted reply is lost, and the transcript says so, since its tokens
are billed but cannot be counted.

### Progress

Every run opens with the mode, model and session id, then stderr carries a live view:
the model's own commentary as it works, each tool call with its key argument, and a
spinner with elapsed time. The mode is repeated above the resume hint at the end, so it
is visible whether you are looking at the top or the bottom of a long answer.

```
plan mode · claude-opus-5 · session 6effca1b  (switched)
I'll start by orienting myself in the project.
  list_tree
A tiny project — let me read everything.
  read_file package.json
⠹ thinking 4s
```

`(switched)` appears only on the run where the mode actually changed.

**stdout is untouched** — still the finished answer, buffered, rendered once as Markdown.
So `bba "..." | glow` or `> out.md` behaves exactly as before, and the spinner is erased
when the turn ends. Off a TTY the animation is skipped and only the meaningful lines are
written. `--quiet` turns it off entirely.

### The transcript

Each session keeps `./.agent/<id>.md`. Your next prompt is whatever you write under the
final `## You` heading — so `-e` opens the whole conversation in one buffer and you
reply at the bottom.

```markdown
## You

Refactor the arg parser.

## Agent

I looked at `src/agent.ts:412`...

## You

<!-- type your next prompt below, save, and re-run -->
```

### Plan vs act

In plan mode `write_file`, `edit_file`, `delete_file` and `run_bash` refuse to run. This
is enforced in the tools, not just asked for in the prompt. The tool *list* is identical
in both modes on purpose — see Caching below.

Switch mode by writing **`!act`** or **`!plan`** on its own line in the transcript — no
need to leave the editor and re-run with a flag. The directive is stripped from the
prompt, and on its own it means "proceed", so `!act` alone runs the plan that was just
written without you restating it.

When the agent finishes a plan it is happy with, it ends its reply with `<!-- !act -->`.
That is stripped from the answer and turns the next prompt stub into the handoff:

```markdown
## You

<!-- The agent is ready to build this. Write !act on its own line to switch to act
     mode and proceed, or reply with changes you want first. -->
```

So the plan → build handoff is one word typed where you are already reading.

### Tools

| Tool | Approval |
|---|---|
| `read_file`, `list_tree`, `search_code`, `web_search` | automatic |
| `write_file`, `edit_file`, `delete_file` | automatic (act mode only) |
| `ask_user` | ends the turn; you answer by re-invoking |
| `run_bash` | **always** requires your explicit approval |

Every path is confined to the current directory; anything resolving outside it, or
inside `.git/` or the session directory, is refused. (The agent reading its own
transcript mid-turn wastes context and muddles the history it is building.)

`ask_user` writes a checkbox list into the transcript. Tick one and re-run:

```markdown
## Agent asks

**Which auth approach?**

- [x] **Session cookies** — simplest, server-side state
- [ ] **JWT** — stateless, harder to revoke
```

`run_bash` never runs anything without you saying so. On a terminal it asks inline and
waits for a single keypress, without ending the turn:

```
run_bash wants to run:
  npm test
  Verify the refactor before moving on.
  [y] run once   [a] always allow this command   [n] decline
  → approved
```

`y` runs it and the agent carries on in the same process — no re-invoke, no re-sending
the history. `a` also appends it to `alwaysApprove` in the config, so it is never asked
again in any session. Only **`n`** ends the turn, writing a `## Declined` block and
handing you the editor to say what to do instead.

With no terminal to ask on — piped stdin, a cron job, CI — it falls back to the
transcript flow instead of hanging: the request is written out and the turn ends, to be
answered with `--approve`, `--always-approve` or `--decline [reason]` on the next run.

## Providers

Set the default in config, or pass `--provider` to start a session on another one. The
provider is **pinned to the session**: a history is written in one API's dialect, with
its tool-call ids and message shapes, so `--provider` on a resume is refused rather than
silently reinterpreted. Sessions written before providers existed resume as `anthropic`.

| | Credential | Default model | Notes |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-5` | Prompt caching, full usage breakdown |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` | No cache reporting — see below |
| `vertex` | `gcloud`, or `VERTEX_ACCESS_TOKEN` | `claude-sonnet-4-5@20250929` | Claude on GCP; caching works |

`bba -l` and the run banner label anything other than Anthropic as `provider:model`.

### DeepSeek

```sh
export DEEPSEEK_API_KEY=...
bba --provider deepseek "explain what this project does"
```

NodeLLM ships a DeepSeek client, so this is ordinary plumbing. Two things differ from
Anthropic. `cache_control` is not sent: every NodeLLM provider spreads unrecognised
request keys straight into the JSON body, so on an OpenAI-shaped API it would arrive as
an unknown top-level field rather than being ignored. DeepSeek caches automatically
anyway, and charges nothing to write.

The cache accounting is the real gap. DeepSeek's API returns `prompt_cache_hit_tokens`,
but NodeLLM's client discards it before this agent sees it, so every token arrives
looking uncached. Rather than print a `0% cached` that describes the missing data instead
of the run, usage for such a provider drops the breakdown and marks the cost as a
ceiling:

```
turn     in 1,200  out 15  ·  1 request  ·  up to $0.0003
```

The real bill is lower by whatever fraction was served from cache.

### Vertex AI

```sh
gcloud auth application-default login
bba --provider vertex --model claude-sonnet-4-5@20250929 "..."
```

Needs a project: `vertexProject` in the config, or `VERTEX_PROJECT` in the environment.
`vertexRegion` defaults to `us-east5`; `global` is understood and drops the host prefix.
Model ids carry Vertex's `@version` suffix and there are no floating aliases, so
`--model` wants the full id.

Credentials are an OAuth token, not a static key. One is minted per run with
`gcloud auth print-access-token`, or taken from `VERTEX_ACCESS_TOKEN` /
`GOOGLE_ACCESS_TOKEN` if set. Tokens last about an hour, which for a long-lived process
would mean refresh logic — but this agent is one turn per invocation, so a fresh token
per run costs one subprocess and removes the problem.

This is the one provider written here rather than by NodeLLM (`src/vertex.ts`), because
none of NodeLLM's knobs can reach Vertex: its Anthropic client posts to
`${baseUrl}/messages` with the model in the JSON body and the key in an `x-api-key`
header, while Vertex puts the model in the URL, wants `anthropic_version` in the body,
and authenticates with a bearer token. It is passed to `createLLM({ provider })` as an
instance. Only the shapes this agent actually sends are converted — text, `tool_use`,
`tool_result` — because no tool here produces an image or a PDF.

`cache_control` works exactly as on the first-party API, and the usage fields come back
in the same three categories, so caching and cost reporting are unchanged.

## Configuration

`~/.barebones-agent/config.json`, created on first run. Precedence is
CLI flag → environment → config file → default.

```json
{
  "provider": "anthropic",
  "model": "claude-opus-5",
  "summaryModel": null,
  "vertexProject": null,
  "vertexRegion": "us-east5",
  "editor": ["code", "--wait"],
  "renderer": "auto",
  "sessionDir": ".agent",
  "compactAt": 0,
  "alwaysApprove": [],
  "tavilyApiKey": null,
  "requestTimeoutMs": 600000,
  "bashTimeoutMs": 120000,
  "pricing": {
    "anthropic/claude-opus-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 10 }
  }
}
```

`pricing` is US dollars per million tokens and merges per model over the built-in table,
so overriding one model keeps the rest. `cacheWrite` is the **1h-TTL** rate (2× input),
which is what this agent always writes at, and both cache rates are optional — leave them
out for a provider that does not bill those separately and the input rate is used.

Keys are `provider/model`, so two providers serving a model of the same name keep
separate rates. A bare `"claude-opus-5"` still works and applies to every provider, which
is what configs written before providers existed contain. Vertex's `@version` suffix is
stripped before the lookup, so `claude-sonnet-4-5@20250929` finds the
`vertex/claude-sonnet-4-5` rate.

`summaryModel` overrides the cheap model used for compaction summaries; `null` takes the
provider's default.

`editor` is an argv array, so there is no shell quoting to get wrong. Known GUI editors
(`code`, `subl`, `zed`, …) get `--wait` appended automatically — without it they return
instantly and the agent reads a transcript you have not typed into yet.

`renderer` is `auto` (use `glow`, else `bat`, else plain), or force one of
`glow` / `bat` / `none`. Under `auto`, if neither is installed the agent says so once per
run before printing plain Markdown — set `renderer` explicitly to silence it. The notice
is skipped when stdout is redirected, since piping already implies you want plain text.

## Caching

Every turn is a fresh process that resends the whole history, so prompt caching is what
makes this affordable rather than absurd. Anthropic's cache is a prefix match over
`tools` → `system` → `messages`, held server-side — exiting the process costs nothing, and
a new invocation with a byte-identical prefix gets a hit.

Two consequences shape the design:

- **The tool list is the same in every mode.** Tools sit at the front of the prefix, so
  withholding one in plan mode would invalidate the entire cache on each switch.
- **The system prompt is byte-stable** — no timestamps, no cwd, no mode text. Mode is
  announced in a message at the end of the history, and only when it changes.

## Token accounting

`--verbose` reports the turn and the running session total; `bba -s <id> --usage` reports
the session total without calling the model.

```
turn     in 5,073 (2,496 cached · 2,573 written · 4 fresh)  out 53  ·  49% cached, 2 requests  ·  $0.0283
session  in 10,628 (7,707 cached · 2,913 written · 8 fresh)  out 340  ·  73% cached, 4 requests  ·  $0.0561
         across 2 turns
```

Input is split three ways because Anthropic bills it three ways: **cached** reads at 0.1x,
**written** (stored into the cache) at 2x on the 1h TTL used here, and **fresh** at 1x.
Anthropic's own `input_tokens` field reports only the fresh remainder, so the totals here
add all three to give the real input volume.

Counts cover **every request in the turn**, not just the last one — a turn with eight tool
rounds makes nine API calls, and all nine are counted.

If `cached` stays near zero across turns of one session, something is perturbing the
prefix. A healthy session shows each turn's `written` becoming the next turn's `cached`.

Costs come from the local `pricing` table, accumulate in dollars (so a mid-session
`--model` switch stays correct), and include the compaction summariser's own call. A
model with no configured price still reports tokens, and the total is marked `$0.0283+
(some models unpriced)` rather than quietly counting it as free.

**Rates are a local table and will go stale** — check them against the provider's pricing
page before trusting a number, and override in config when they change. The DeepSeek
rates in particular are a seed, not a promise.

## Compaction

Off by default. Set `compactAt` to an input-token threshold, or force it with `--compact`.
The first user message and the last four turns are kept verbatim; everything between is
summarised by one cheap call — Haiku on Anthropic and Vertex, `deepseek-chat` on
DeepSeek, or whatever `summaryModel` names. Cuts always land on a turn boundary, so a tool call is
never separated from its result.

Compaction rewrites the prefix and therefore throws away the cache, which is why it is
threshold-triggered rather than run every turn. The transcript always keeps the full
record — compaction only affects what is sent to the model.

## Layout

```
src/context.ts    shared types, pricing table, path guard, tool context
src/tools.ts      the nine tools
src/progress.ts   stderr activity display
src/compact.ts    history compaction
src/providers.ts  the provider table, and building a client from it
src/vertex.ts     the Vertex AI provider NodeLLM does not ship
src/agent.ts      config, session, transcript, main
```

## Timeouts

NodeLLM's own default is a **30-second** cap per HTTP request, which a reasoning model
exploring a real codebase exceeds routinely. This raises it to 600s (`requestTimeoutMs`).

Timeouts identify themselves. A model-API timeout says so explicitly and names the flag
to raise it; a `run_bash` timeout is reported by the tool with the command that stalled,
so the agent can tell you and suggest `--bash-timeout`. Either way the turn's work is
saved to the session first, so nothing already done is lost.

## Notes

- `@node-llm/core` 1.17.0's model registry does not know `claude-opus-5`. Rather than
  skip validation (which drops the output ceiling to 8k and logs a warning every run),
  the agent registers unknown models with `ModelRegistry.save()` before use, taking
  their rates from the `pricing` config. Any newer model id works the same way. This is
  a no-op for DeepSeek, whose four models the bundled registry does know, and
  load-bearing for Vertex, which has no entries there at all.
- Its providers are `anthropic`, `bedrock`, `deepseek`, `gemini`, `mistral`, `ollama`,
  `openai`, `openrouter` and `xai` — no Vertex, hence `src/vertex.ts`.
- NodeLLM does not emit `cache_control` itself; unknown params are spread into the
  request body, which is how top-level auto-caching is reached. That same spread is why
  it is sent only to Anthropic and Vertex: elsewhere it would be an unknown body field,
  not an ignored one.
- Its DeepSeek client maps only `prompt_tokens` and `completion_tokens`, dropping
  `prompt_cache_hit_tokens`, so no cache breakdown is available on that provider.
- Its default agentic loop cap is 5 tool rounds (`maxToolCalls`), raised to 50 here.
- `chat.totalUsage` omits `cache_creation_tokens`, so usage is summed from the per-message
  `usage` NodeLLM attaches to history instead.
- NodeLLM's pricing registry has no `claude-opus-5` entry, so costs are computed from
  the local `pricing` table rather than from its `usage.cost`.
- Its `AskOptions.signal` never reaches the wire on Anthropic: the provider spreads
  unrecognised keys into the request body (the same channel `cache_control` rides), so a
  signal would be sent as `"signal":{}` and rejected. Cutting a request therefore wraps
  `globalThis.fetch` for the duration of the model call — see `withCuttableFetch`.
- Its tool loop stops at a `halt()` *after* running the rest of the round, discarding the
  results it did not reach and leaving those `tool_use` blocks unanswered. Anthropic
  rejects a history in that shape, so `repairDangling` synthesises the missing results on
  every load and save. This also fixes two failures that predate interrupts: a turn that
  trips `maxToolCalls`, and `ask_user`/`run_bash` halting in a batched round.
- It also discards Anthropic's `stop_reason`, so a refusal arrives as an empty response.
  The agent says so rather than writing a blank section.
