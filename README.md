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

Optionally `npm link` to get `bba` on your PATH; otherwise call `node dist/agent.js`.

## Usage

```sh
bba "explain what this project does"    # start a session
bba -s <id> "now add a --version flag"  # continue it
bba -s <id> -e                          # edit the transcript, then run what you wrote
bba -s <id>                             # run whatever is under the last "## You"
bba -s <id> -f prompt.md                # take the prompt from a file
```

Every run prints the exact command to continue:

```
↻  bba -s 7f3a2c91 -e
```

| Flag | |
|---|---|
| `--plan` / `--act` | Switch mode; persists in the session |
| `--approve` | Run the pending shell command once |
| `--always-approve` | Run it, and never ask for that exact command again |
| `--decline [reason]` | Refuse it; with no reason, hands control back to you |
| `--compact` | Compact the history now |
| `--timeout <s>` | Per-request limit for the model API (default 600s) |
| `--bash-timeout <s>` | Limit for a single `run_bash` command (default 120s) |
| `--quiet` | No progress output |
| `--usage` | Report the session's token spend and exit |
| `--model <id>` `--editor <cmd>` `--compact-at <n>` `--verbose` `--help` | |

### Progress

While a turn runs, stderr carries a live view: the model's own commentary as it works,
each tool call with its key argument, and a spinner with elapsed time.

```
I'll start by orienting myself in the project.
  list_tree
A tiny project — let me read everything.
  read_file package.json
  read_file src/server.js
⠹ thinking 4s
```

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

`run_bash` never runs anything without you saying so, and the transcript spells out the
three ways to respond.

## Configuration

`~/.barebones-agent/config.json`, created on first run. Precedence is
CLI flag → environment → config file → default.

```json
{
  "model": "claude-opus-5",
  "editor": ["code", "--wait"],
  "renderer": "auto",
  "sessionDir": ".agent",
  "compactAt": 0,
  "alwaysApprove": [],
  "tavilyApiKey": null,
  "requestTimeoutMs": 600000,
  "bashTimeoutMs": 120000,
  "pricing": {
    "claude-opus-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 10 }
  }
}
```

`pricing` is US dollars per million tokens and merges per model over the built-in table,
so overriding one model keeps the rest. `cacheWrite` is the **1h-TTL** rate (2× input),
which is what this agent always writes at.

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

**Rates are a local table and will go stale** — check them against Anthropic's pricing
page before trusting a number, and override in config when they change.

## Compaction

Off by default. Set `compactAt` to an input-token threshold, or force it with `--compact`.
The first user message and the last four turns are kept verbatim; everything between is
summarised by a cheap Haiku call. Cuts always land on a turn boundary, so a tool call is
never separated from its result.

Compaction rewrites the prefix and therefore throws away the cache, which is why it is
threshold-triggered rather than run every turn. The transcript always keeps the full
record — compaction only affects what is sent to the model.

## Layout

```
src/context.ts   shared types, path guard, tool context
src/tools.ts     the nine tools
src/progress.ts  stderr activity display
src/compact.ts   history compaction
src/agent.ts     config, session, transcript, main
```

## Timeouts

NodeLLM's own default is a **30-second** cap per HTTP request, which a reasoning model
exploring a real codebase exceeds routinely. This raises it to 600s (`requestTimeoutMs`).

Timeouts identify themselves. A model-API timeout says so explicitly and names the flag
to raise it; a `run_bash` timeout is reported by the tool with the command that stalled,
so the agent can tell you and suggest `--bash-timeout`. Either way the turn's work is
saved to the session first, so nothing already done is lost.

## Notes

- `@node-llm/core` 1.17.0's model registry does not yet know `claude-opus-5`, so the
  agent passes `assumeModelExists` and sets `max_tokens` explicitly. Any newer model id
  works the same way.
- NodeLLM does not emit `cache_control` itself; unknown params are spread into the
  request body, which is how top-level auto-caching is reached.
- Its default agentic loop cap is 5 tool rounds (`maxToolCalls`), raised to 50 here.
- `chat.totalUsage` omits `cache_creation_tokens`, so usage is summed from the per-message
  `usage` NodeLLM attaches to history instead.
- NodeLLM's pricing registry has no `claude-opus-5` entry, so costs are computed from
  the local `pricing` table rather than from its `usage.cost`.
- It also discards Anthropic's `stop_reason`, so a refusal arrives as an empty response.
  The agent says so rather than writing a blank section.
