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
brew install ripgrep              # required
brew install glow                 # optional, for rendered output
uv tool install 'litellm[proxy]'  # required — the agent talks to nothing else
npm install && npm run build
```

Every model reaches the agent through a local [LiteLLM](https://docs.litellm.ai/) proxy,
so there are no API keys here and no provider code in this repo — see
[The proxy](#the-proxy).

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
| `--model <alias>` | A `model_name` from the proxy's `model_list`; sticks to the session |
| `--approve` | Run the pending shell command once (non-interactive fallback) |
| `--always-approve` | Run it, and never ask for that exact command again |
| `--decline [reason]` | Refuse it; with no reason, hands control back to you |
| `--timeout <s>` | Per-request limit for the model API (default 600s) |
| `--bash-timeout <s>` | Limit for a single `run_bash` command (default 120s) |
| `--quiet` | No progress output, including the per-turn token line |
| `--usage` | Report the session's token usage and exit |
| `-l` / `--sessions` | List the sessions saved in this directory, newest first, each with the command to resume it |
| `Ctrl-C` | Stop the turn and save it; twice cuts a request in flight |
| `--editor <cmd>` `--verbose` `--help` | |

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

Narration starts at what this turn adds. A resumed session hands the model its whole
history before the turn begins, so the mark the narrator opens at is that restored
length — otherwise the first tool call replays every answer the session has ever given.

#### Edits

`write_file` and `edit_file` show what they changed, in the same stream, so an edit can
be read as it lands rather than reconstructed from `git diff` afterwards:

```
  edit_file src/greet.ts:12 +2 -2
  -  const greeting = "hello";
  -  console.log(greeting + " " + name);
  +  const greeting = "hey there";
  +  console.log(`${greeting} ${name}`);
```

There is no diff algorithm behind this, and no `diff` subprocess. There does not need to
be: `edit_file` is handed the before and after text as `old_string` and `new_string`, so
the change is already sitting in the tool's arguments. `old_string` is also the span the
model *chose* to replace, which makes printing it verbatim more faithful than a
re-derived diff — you see the edit the way the model meant it, not the minimal one an
algorithm would find inside it.

Creating a file is labelled `(new file)` and is all additions; overwriting one shows what
it replaced as well; writing identical bytes says `(no change)`. The body is capped at
200 lines, removals giving way first, with a count of what was held back.

The model gets only the `+2 -1` stat back: it wrote the change, and feeding it back would
bill you for reading it twice. `--quiet` suppresses this along with the rest of the
narration.

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
| `read_file`, `list_tree`, `search_code` | automatic |
| `git_status`, `git_log`, `git_merge_base`, `git_diff` | automatic |
| `write_file`, `edit_file`, `delete_file` | automatic (act mode only); the first two show what changed |
| `run_bash` | **always** requires your explicit approval |

Every path is confined to the current directory; anything resolving outside it, or
inside `.git/` or the session directory, is refused. (The agent reading its own
transcript mid-turn wastes context and muddles the history it is building.)

### Git tools

The agent has direct access to git information without needing `run_bash`:

- **`git_status`** — working directory status (modified, staged, untracked files)
- **`git_log`** — commit history with optional diffs
  - `limit`: number of commits (default 10, or 1 if `patch=true`)
  - `patch`: include full diffs for each commit
  - `path`: scope to specific file/directory
  - `ref`: show log for a specific branch/ref
- **`git_merge_base`** — find common ancestor between refs
  - Auto-detects main branch (tries `origin/main`, `origin/master`, `main`, `master`)
  - Useful for finding where a branch diverged
- **`git_diff`** — show differences between refs or working directory
  - `ref1`, `ref2`: compare any two commits/branches
  - `path`: scope to specific file/directory
  - `stat`: show only file statistics instead of full diff
  - `cached`: show staged changes

**Typical workflow** to see changes in current branch vs main:
```
1. git_merge_base(ref2="origin/main") → returns merge-base SHA
2. git_diff(ref1="<that-sha>", ref2="HEAD") → shows all changes
```

Or compare branches directly: `git_diff(ref1="origin/main", ref2="HEAD")`.

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
the history. `a` also appends it to `alwaysApprove` in the project config, so it is never
asked again in this project. Only **`n`** ends the turn, writing a `## Declined` block
and handing you the editor to say what to do instead.

With no terminal to ask on — piped stdin, a cron job, CI — it falls back to the
transcript flow instead of hanging: the request is written out and the turn ends, to be
answered with `--approve`, `--always-approve` or `--decline [reason]` on the next run.

## The proxy

The agent speaks one dialect to one endpoint: an OpenAI-compatible `/v1/chat/completions`
on `127.0.0.1:4000`. A LiteLLM proxy sits there and fans out to Vertex, DeepSeek,
Anthropic or anything else it supports.

That is the whole provider story. There is no provider table, no `--provider` flag, no
per-provider model map, and no hand-written client. `--model` names a `model_name` from
the proxy's `model_list`, and everything behind that alias — which upstream, which
credentials, which region, which caching — is the proxy's business:

```sh
bba --model vertex-claude "..."      # -> vertex_ai/claude-sonnet-4-5
bba --model deepseek "..."           # -> deepseek/deepseek-chat
```

Adding a backend means editing YAML, not TypeScript.

### Setting it up

Copy both templates out of this repo and fill in the placeholders:

```sh
mkdir -p ~/.barebones-agent
cp litellm.yaml ~/.barebones-agent/litellm.yaml     # then set your GCP project
gcloud auth application-default login                # Vertex auth, once

sed -e "s|__HOME__|$HOME|g" -e "s|__LITELLM__|$(command -v litellm)|g" \
  com.barebones-agent.litellm.plist \
  > ~/Library/LaunchAgents/com.barebones-agent.litellm.plist
chmod 600 ~/Library/LaunchAgents/com.barebones-agent.litellm.plist   # it holds keys
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.barebones-agent.litellm.plist
```

`launchd` starts the proxy at login and restarts it if it dies (`RunAtLoad` +
`KeepAlive`), so it outlives any single `bba` invocation. The agent contains **no**
process management — no spawning, no health polling, no PID files. It makes a request,
and says what to run if nothing answers.

Two things launchd does not give you, which is why the templates look the way they do:

- **It does not inherit your shell `PATH`**, so `ProgramArguments` needs litellm's
  absolute path (`command -v litellm`, substituted above).
- **It does not inherit your exported API keys**, so `DEEPSEEK_API_KEY` and friends live
  in the plist's `EnvironmentVariables` rather than in your shell profile. Vertex is the
  exception: it authenticates through the Application Default Credentials file that
  `gcloud auth application-default login` writes, which launchd can read.

### Operating it

```sh
launchctl kickstart -k gui/$(id -u)/com.barebones-agent.litellm   # restart, e.g. after editing the YAML
launchctl print gui/$(id -u)/com.barebones-agent.litellm          # is it running?
launchctl bootout gui/$(id -u)/com.barebones-agent.litellm        # stop it
curl -s localhost:4000/health/liveliness                          # unauthenticated probe
tail -f ~/.barebones-agent/litellm.log
```

## Configuration

`~/.barebones-agent/config.json`, created on first run. Precedence is
CLI flag → environment → config file → default.

```json
{
  "model": "deepseek",
  "baseUrl": "http://127.0.0.1:4000/v1",
  "apiKeyEnv": "LITELLM_MASTER_KEY",
  "editor": ["code", "--wait"],
  "renderer": "auto",
  "sessionDir": ".agent",
  "requestTimeoutMs": 600000,
  "bashTimeoutMs": 120000
}
```

`model` is a `model_name` from the proxy's `model_list`, not a provider's own model id.
`--model` beats it for one run and sticks to that session.

`baseUrl` is where the proxy is listening, and takes **no trailing slash** — request URLs
are built by string concatenation, so one would produce `/v1//chat/completions`.
`apiKeyEnv` names the env var holding the proxy's key; if the proxy has no `master_key`
set, leave it, since nothing reads the value.

`editor` is an argv array, so there is no shell quoting to get wrong. Known GUI editors
(`code`, `subl`, `zed`, …) get `--wait` appended automatically — without it they return
instantly and the agent reads a transcript you have not typed into yet.

`renderer` is `auto` (use `glow`, else `bat`, else plain), or force one of
`glow` / `bat` / `none`. Under `auto`, if neither is installed the agent says so once per
run before printing plain Markdown — set `renderer` explicitly to silence it. The notice
is skipped when stdout is redirected, since piping already implies you want plain text.

### Project configuration

Per-project settings live in `.agent/project.json`, beside the session files. This file is
optional and not created automatically.

```json
{
  "contextFile": "GOOD_TO_KNOW.md",
  "alwaysApprove": ["npm test", "npm run build"]
}
```

`contextFile` overrides the default project context file. By default, new sessions
automatically read `AGENTS.md` (or `README.md` as a fallback) from the project root to
give the agent project-specific context. Set this to use a different file instead.

`alwaysApprove` lists shell commands that `run_bash` may execute without asking. These are
project-specific — a command approved in one repo does not carry to another. Use
`--always-approve` to add to this list interactively.

Approved commands may be extended with `| head`, `| tail`, `| grep`, or `2>&1` without
re-approval — so `npm test | grep error | head -20` runs if `npm test` is approved. For
security, suffixes containing shell metacharacters (`$`, `` ` ``, `<`, `>`) are rejected
to prevent command substitution and file redirection attacks. The `grep -f` flag is also
blocked since it reads patterns from arbitrary files. Keep approved commands narrow:
prefer `npm test` over `npm` to limit what variations the agent can run.

## Caching

Every turn is a fresh process that resends the whole history, so prompt caching is what
makes this affordable rather than absurd. Anthropic's cache is a prefix match over
`tools` → `system` → `messages`, held server-side — exiting the process costs nothing, and
a new invocation with a byte-identical prefix gets a hit.

**The agent sends nothing to arrange this.** The OpenAI wire format has no top-level
`cache_control`, and its per-message form needs structured content blocks the agent does
not produce. So the breakpoints are injected by the proxy instead, via
`cache_control_injection_points` in `litellm.yaml` — one on the system message, one on
the tool definitions, together covering the whole stable prefix. DeepSeek gets no such
block: it caches automatically and has no opt-in parameter.

Two consequences still shape the agent's design:

- **The tool list is the same in every mode.** Tools sit at the front of the prefix, so
  withholding one in plan mode would invalidate the entire cache on each switch.
- **The system prompt is byte-stable** — no timestamps, no cwd, no mode text. Mode is
  announced in a message at the end of the history, and only when it changes.

## Token accounting

Every turn ends with what it moved, on stderr next to the resume hint:

```
turn     in 5,073  out 53  ·  2 requests

act mode · continue with:
↻  bba -s 7f3a2c91 -e
```

`--verbose` adds the running session total under it, and `bba -s <id> --usage` reports
that total on its own without calling the model. `--quiet` drops the line along with the
rest of the stderr narration.

An interrupted or failed turn reports too — it still spent the tokens, and its work is
still saved to the session.

Tokens only — there is no cost estimate, because a price table kept in this repo goes
stale silently and the provider's own console is authoritative.

`in` is the whole prompt volume, cached or not, taken straight from the proxy's
`prompt_tokens` — the OpenAI shape already counts cached tokens inside that figure rather
than in a separate bucket. (Reading it the Anthropic way, where `input_tokens` is the
uncached remainder and the cache counters are added back, would double-count every cached
token here.)

Cache **writes** are not visible: LiteLLM reports `cache_creation_input_tokens`, but the
client only reads `prompt_tokens_details.cached_tokens`. To confirm caching is working,
read `~/.barebones-agent/litellm.log` rather than this line.

Counts cover **every request in the turn**, not just the last one — a turn with eight tool
rounds makes nine API calls, and all nine are counted.

## Layout

```
src/context.ts    shared types, path guard, tool context
src/tools.ts      the eight tools
src/progress.ts   stderr activity display
src/changes.ts    what an edit changed, painted for the terminal
src/history.ts    repairing a history an interrupted turn left dangling
src/agent.ts      config, session, transcript, main

litellm.yaml                       proxy routing + cache injection (template)
com.barebones-agent.litellm.plist  LaunchAgent keeping the proxy alive (template)
```

## Timeouts

NodeLLM's own default is a **30-second** cap per HTTP request, which a reasoning model
exploring a real codebase exceeds routinely. This raises it to 600s (`requestTimeoutMs`).

Timeouts identify themselves. A model-API timeout says so explicitly and names the flag
to raise it; a `run_bash` timeout is reported by the tool with the command that stalled,
so the agent can tell you and suggest `--bash-timeout`. Either way the turn's work is
saved to the session first, so nothing already done is lost.

## Notes

- Everything reaches the model through NodeLLM's stock `openai` client, pointed at the
  proxy with `openaiApiBase`. The key is spelled `openaiApiBase`, not `baseUrl`, and
  `openaiApiKey` must be non-empty even when the proxy checks nothing — the client
  refuses to construct without one, so a placeholder stands in.
- Model ids here are proxy aliases the bundled registry has never seen, and an unknown id
  fails NodeLLM's tool-support check outright with *"does not support tool calling"*. The
  agent registers the alias with `ModelRegistry.save()` before every run. Unconditionally,
  not on a lookup miss: `ModelRegistry.find()` falls back to a bidirectional prefix match,
  so an alias could otherwise resolve to some unrelated bundled entry and inherit its
  limits. (`assumeModelExists` is the wrong lever — it only downgrades the check to a
  warning logged every run, and leaves the output ceiling at 4k.)
- Its default agentic loop cap is 5 tool rounds (`maxToolCalls`), raised to 50 here.
- `chat.totalUsage` omits some counters, so usage is summed from the per-message `usage`
  NodeLLM attaches to history instead.
- The OpenAI provider strips `signal` from the request body and forwards it to `fetch`,
  so `chat.ask(prompt, { signal })` is enough to cut a request in flight. The Anthropic
  provider does neither, which is why an earlier version of this agent had to monkey-patch
  `globalThis.fetch`; going through the proxy deleted that workaround.
- Its tool loop stops at a `halt()` *after* running the rest of the round, discarding the
  results it did not reach and leaving those `tool_use` blocks unanswered. Every API
  rejects a history in that shape, so `repairDangling` synthesises the missing results on
  every load and save. This also fixes two failures that predate interrupts: a turn that
  trips `maxToolCalls`, and `run_bash` halting in a batched round.
- A refusal can arrive as an empty response. The agent says so rather than writing a blank
  section.
