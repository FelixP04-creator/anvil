# anvil

**An open-source coding agent that lives in your terminal — and in your browser.**

anvil is a small, readable, MIT-licensed coding agent written in plain
TypeScript (no build step, no runtime dependencies). Point it at a task and it
reads, edits, searches, and runs commands in your project until the task is
done — with a permission system that keeps you in control.

> anvil is an independent, original implementation. It contains no code,
> prompts, or assets from any other product, and is not affiliated with or
> endorsed by Anthropic or OpenAI.

<p align="center">
  <img src="docs/screenshot.png" alt="anvil web UI: session sidebar with live todo panel, streamed markdown answer with syntax highlighting, compact tool chips, and a red stop button" width="900">
</p>

## Features

- **Agent loop with streaming** — the model proposes tool calls, anvil
  executes them, results go back to the model, until the task is done or the
  turn limit is hit. Model text is streamed token by token (CLI and web).
- **Two providers** — Anthropic Messages API and any OpenAI-compatible
  endpoint (`OPENAI_BASE_URL`), selected by `--provider` or by which API key
  is set.
- **Core tools** — `Read`, `Write`, `Edit` (exact-match replacement), `Bash`,
  `Glob`, `Grep`, `TodoWrite`, and `Task` (subagents with their own context
  window).
- **Permission modes** — `default` (ask once/always/deny), `acceptEdits`
  (auto-approve file edits), `plan` (strictly read-only), `bypass` (no
  prompts).
- **Memory** — project instructions from `ANVIL.md` in the working directory
  and user instructions from `~/.anvil/ANVIL.md` are loaded into the system
  prompt.
- **Web UI** — `anvil server` starts a dependency-free REST + SSE server with
  a modern web interface: streamed markdown answers with syntax-highlighted
  code blocks, a session sidebar with auto-titles and status dots, a live
  todo panel, collapsible tool-call chips, in-browser permission prompts,
  light/dark themes, and a red stop button that aborts a running turn.
- **Multi-turn sessions** — the CLI REPL and web sessions keep the full
  conversation history across turns.

## Quickstart (CLI)

Requires **Node.js ≥ 23.6** (native TypeScript — no build step, no runtime dependencies).

**Via npm** (installs the `anvil` command):

```sh
npm install -g anvil-code

export ANTHROPIC_API_KEY=sk-ant-...   # or: export OPENAI_API_KEY=...
anvil "fix the failing test in test/auth.test.ts"
anvil                                  # interactive session
```

**From a checkout** (no install needed):

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # or: export OPENAI_API_KEY=...

node src/index.ts "fix the failing test in test/auth.test.ts"
node src/index.ts                     # interactive session
node src/index.ts --mode acceptEdits "refactor src/utils.ts"
node src/index.ts --provider openai --model gpt-4o "explain this repo"
```

In interactive mode: `/help`, `/mode <mode>`, `/todos`, `/exit`.

## Web UI

```sh
node src/index.ts server                    # http://localhost:8787
node src/index.ts server --port 9000 --cwd /path/to/project
```

Open the printed URL. The UI streams the agent's answer as markdown (with
syntax-highlighted, copyable code blocks), shows every tool call as a
collapsible chip with its output, and renders permission requests as cards
(Allow once / Always allow / Deny — also answerable with the keys `1`/`2`/`3`).
The permission mode can be switched live in the header.

- **Sessions** — the sidebar lists every session with an auto title (first
  message), turn count, and a status dot (pulsing while working, amber while
  waiting for a permission). Sessions survive page reloads: the `?session=<id>`
  deep link reopens them, and the transcript is replayed from the server,
  including a permission prompt that is still pending.
- **Stop** — while a turn is running the send button turns red; clicking it
  (or pressing `Esc`) aborts the turn: the in-flight model call is cancelled
  and a pending permission prompt is resolved as denied.
- **Todos** — the sidebar shows the session's live todo list (as maintained by
  the `TodoWrite` tool), with a `done/total` counter.
- **Themes & keys** — dark (default) or light theme, remembered per browser;
  `⌘/Ctrl+K` focuses the input, `N` starts a new session, `Esc` stops a turn.
  Auto-scroll stays pinned while you are at the bottom and otherwise offers a
  "latest" jump button. Token usage is shown next to the status line.

Try it without any API key — a scripted mock provider with a pre-seeded
conversation (one finished turn, one turn waiting at a permission prompt):

```sh
node scripts/demo-server.ts        # prints a ready-made session URL
```

### HTTP API (used by the UI, open to anything else)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | liveness + version |
| `POST` | `/api/sessions` | create a session (`{ "mode": "default" }`) |
| `GET` | `/api/sessions` | list sessions (auto title, mode, busy, turns, permission-pending) |
| `GET` | `/api/sessions/:id` | state: title, mode, busy, todos, usage, turns, pending permission |
| `DELETE` | `/api/sessions/:id` | delete a session (aborts a running turn first) |
| `GET` | `/api/sessions/:id/transcript` | renderable replay of everything that happened |
| `POST` | `/api/sessions/:id/messages` | `{ "text": "…" }` → starts a turn (202) |
| `POST` | `/api/sessions/:id/abort` | stop the running turn (`{ "stopped": true }`) |
| `GET` | `/api/sessions/:id/events` | SSE stream of agent events |
| `POST` | `/api/sessions/:id/permissions` | `{ "id": "perm-1", "answer": "once" }` |
| `POST` | `/api/sessions/:id/mode` | `{ "mode": "plan" }` |

SSE events: `session`, `assistant_delta`, `assistant_text`, `tool_start`,
`tool_end`, `permission_request`, `permission_resolved`, `denied`, `error`,
`aborted`, `todos`, `turn_end`, `mode_changed`.

## Configuration

| Variable / file | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | anthropic provider |
| `OPENAI_API_KEY` | openai provider |
| `OPENAI_BASE_URL` | OpenAI-compatible gateway (default `https://api.openai.com/v1`) |
| `ANVIL_MODEL` / `OPENAI_MODEL` | default model per provider |
| `ANVIL.md` (working dir) | project memory, loaded into the prompt |
| `~/.anvil/ANVIL.md` | user memory, loaded into the prompt |

## Architecture

```
src/
├── index.ts            CLI: arg parsing, one-shot / interactive / server
├── repl.ts             interactive loop: streamed output, permission prompts
├── server.ts           REST + SSE server, sessions, static web UI
├── agent.ts            the agent loop (model ⇄ tools), event emission
├── permissions.ts      permission modes + ask/always/deny rules
├── prompt.ts           original system prompts + environment detection
├── memory.ts           ANVIL.md loading (project + user)
├── types.ts            shared types (Tool, Provider, messages)
├── providers/
│   ├── index.ts        provider factory (flag or key detection)
│   ├── anthropic.ts    Messages API, SSE streaming, no SDK
│   └── openai.ts       chat completions, SSE streaming, tool-calls
└── tools/
    ├── read.ts  write.ts  edit.ts  bash.ts  glob.ts  grep.ts
    ├── todo.ts         todo list (exactly one in_progress at a time)
    ├── task.ts         subagent delegation (nested agent loop)
    └── index.ts        tool registry
bin/
└── anvil.js            npm launcher shim (npm rejects .ts bin entries)
web/
├── index.html  styles.css  app.js   dependency-free UI (vanilla JS)
scripts/
└── demo-server.ts              web UI demo, no API key needed
test/
├── smoke.ts            agent loop, tools, permissions (mock provider)
└── server-smoke.ts     HTTP server: sessions, SSE, permission round-trip
```

**Agent loop** (`agent.ts`): the conversation history is a plain array of
messages kept by the caller (REPL, web session, subagent). Each turn sends
`system + messages + tool schemas` to the provider; streamed text deltas are
forwarded as events. If the reply contains tool calls, each one goes through
the permission engine, is executed, and the results are appended as
`tool_result` blocks. The loop ends when the model replies with plain text or
`maxTurns` is reached.

**Permissions** (`permissions.ts`): read-only tools never ask. In `default`
mode every new tool — or, for Bash, every new two-word command prefix —
prompts with `once / always / deny`; `always` is remembered for the session.
One-shot (non-interactive) mode denies anything that would ask, so scripts
are safe by default.

**Subagents** (`tools/task.ts`): `Task` runs a nested agent loop with the
subagent prompt and the core tools (no `Task` itself, so no recursion).

**Server** (`server.ts`): each session owns its conversation history, tool
context, and permission engine. Permission prompts suspend the turn as a
pending promise and are broadcast over SSE; the UI answers them through the
API. The SSE subscription is registered before the response starts, so no
event can be lost.

## Design notes

- Zero runtime dependencies: `node:fs`, `node:child_process`, `node:http`,
  global `fetch`. Glob and Grep are plain TypeScript; the SSE parsers for
  both provider APIs are hand-rolled.
- Node's native TypeScript support means the source *is* the distribution —
  no bundler, no lockfile.
- Every mutating action is either auto-approved by an explicit mode choice or
  visible to the user.

## Development

```sh
node test/smoke.ts         # agent loop, tools, permissions (no network)
node test/server-smoke.ts  # HTTP server: sessions, SSE, permission flow
```

## License

[MIT](./LICENSE) — original work.
