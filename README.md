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
| `--model <id>` `--editor <cmd>` `--compact-at <n>` `--verbose` `--help` | |

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

### Tools

| Tool | Approval |
|---|---|
| `read_file`, `list_tree`, `search_code`, `web_search` | automatic |
| `write_file`, `edit_file`, `delete_file` | automatic (act mode only) |
| `ask_user` | ends the turn; you answer by re-invoking |
| `run_bash` | **always** requires your explicit approval |

Every path is confined to the current directory; anything resolving outside it, or
inside `.git/`, is refused.

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
  "tavilyApiKey": null
}
```

`editor` is an argv array, so there is no shell quoting to get wrong. Known GUI editors
(`code`, `subl`, `zed`, …) get `--wait` appended automatically — without it they return
instantly and the agent reads a transcript you have not typed into yet.

`renderer` is `auto` (use `glow`, else `bat`, else plain), or force one of
`glow` / `bat` / `none`.

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

Run with `--verbose` to see it working:

```
tokens: in 2 (cached 3102) out 35
```

If `cached` is 0 on a second turn of the same session, something is perturbing the prefix.

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
src/compact.ts   history compaction
src/agent.ts     config, session, transcript, main
```

## Notes

- `@node-llm/core` 1.17.0's model registry does not yet know `claude-opus-5`, so the
  agent passes `assumeModelExists` and sets `max_tokens` explicitly. Any newer model id
  works the same way.
- NodeLLM does not emit `cache_control` itself; unknown params are spread into the
  request body, which is how top-level auto-caching is reached.
- It also discards Anthropic's `stop_reason`, so a refusal arrives as an empty response.
  The agent says so rather than writing a blank section.
