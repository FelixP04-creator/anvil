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
  <img src="docs/screenshot.png" alt="anvil web UI: a collapsible thinking block above compact tool chips and a streamed markdown answer with syntax-highlighted code" width="900">
</p>

## Features

- **Agent loop with streaming** — the model proposes tool calls, anvil
  executes them, results go back to the model, until the task is done or the
  turn limit is hit. Model text is streamed token by token (CLI and web).
- **Robust loop** — transient provider errors (rate limits, overloads, network
  blips) are retried with exponential backoff, a reply cut off by the token
  limit is continued automatically instead of being handed back truncated
  (including a cutoff inside a tool call), and malformed tool-call JSON from
  the model is retried instead of failing the turn. Provider calls are
  guarded by timeouts (connection, first token, and stream idle), so a stalled
  model call surfaces an error instead of hanging the session forever.
- **Four providers** — Anthropic Messages API, any OpenAI-compatible
  endpoint (`OPENAI_BASE_URL`), the HSNR gateway (`ai.ide3.de`, models
  `Qwen/Qwen3.8-27B`, `zai-org/GLM-5.3`, `ultrabrain`, `smallbrain`), and
  **local runtimes** (Ollama / LM Studio auto-detected on
  `127.0.0.1:11434` / `127.0.0.1:1234` — no API key), selected by
  `--provider`, the settings dialog, or by which API key is set; with no key
  anywhere, a running local runtime is the out-of-the-box fallback.
- **Model & thinking settings** — choose the model and an extended-thinking
  effort (`off` / `low` / `medium` / `high`) in the web UI settings dialog,
  via `anvil config`, a CLI flag, or environment variables. In the web UI the
  model can also be switched mid-conversation from the header dropdown (the
  new model applies from the next message). Effort maps to
  Anthropic thinking budgets and OpenAI `reasoning_effort`; thinking streams
  back as its own collapsible block in the UI and is kept in the conversation
  history as the APIs require.
- **Core tools** — `Read`, `Write`, `Edit` (exact-match replacement), `Bash`,
  `Glob`, `Grep`, `TodoWrite`, and `Task` (subagents with their own context
  window).
- **Permission modes** — `default` (ask once/always/deny), `acceptEdits`
  (auto-approve file edits), `plan` (strictly read-only), `bypass` (no
  prompts).
- **Memory** — project instructions from `ANVIL.md` in the working directory
  and user instructions from `~/.anvil/ANVIL.md` are loaded into the system
  prompt.
- **Live streaming markdown** — answers are rendered as markdown *while* they
  stream (headings, lists, tables, syntax-highlighted code), not as one
  squashed block after completion; even an unclosed code fence renders live.
- **Live file-change diffs** — every `Write`/`Edit` the agent makes (main
  session or subagent) is diffed against the previous file content and shown
  as a collapsible card with old/new line numbers and `+N/−M` stats.
- **Image input** — attach up to 8 images per message (paste, drag & drop, or
  file picker) in the web UI; they reach the model as native image blocks
  (Anthropic base64 source / OpenAI `data:` URL) and appear in the transcript.
- **Web UI** — `anvil server` starts a dependency-free REST + SSE server with
  a modern web interface: streamed markdown answers with syntax-highlighted
  code blocks, a session sidebar with auto-titles, status dots, and a search
  box, a live todo panel, collapsible tool-call chips, in-browser permission
  prompts, a settings dialog for provider/keys/model/thinking, light/dark
  themes, a red stop button that aborts a running turn, slash commands with
  autocomplete (`/help /new /fork /model /thinking /mode /export /notify`),
  browser notifications for permission prompts and finished turns (when the
  tab is hidden), and one-click export of the conversation as Markdown or a
  self-contained HTML file. The layout is touch-friendly on phones.
- **Offline model in the browser** — a self-contained page (the “Offline
  model” button in the web UI, `/local-chat.html`) runs a small language
  model *entirely on the device* via WebGPU: one-time weight download
  (Qwen2-0.5B ≈ 350 MB, Llama-3.2-1B ≈ 750 MB, Llama-3.2-3B ≈ 1.7 GB), then
  chat with zero internet and zero API keys. Chat only — no tools, no file
  access.
- **Apps** — a self-contained Windows EXE (CLI + web server in one
  ~95 MB binary, no Node install) and Android/iOS apps that window the
  server UI over your LAN plus the offline model — all downloadable from the
  [releases](https://github.com/FelixP04-creator/anvil/releases).
- **Sessions that survive** — web sessions and CLI conversations are stored
  as JSON next to the config file. The web UI reloads them after a server
  restart; the CLI resumes them with `anvil -c` (most recent) or
  `anvil -r <id>` (by id or prefix), and `anvil sessions` lists them with
  model, turn count, and age.
- **Session forking** — branch any session at any assistant message (the web
  UI shows a fork button per answer; the API is
  `POST /api/sessions/:id/fork`), then continue both branches independently.
- **Multi-turn sessions** — the CLI REPL and web sessions keep the full
  conversation history across turns.

## Quickstart (CLI)

Requires **Node.js ≥ 23.6** (native TypeScript — no build step, no runtime dependencies).

**Via npm** (installs the `anvil` command):

```sh
npm install -g anvil-code

anvil config set anthropic-key sk-ant-...      # store your key once (or use env vars)
anvil config set model claude-sonnet-4-5       # optional: pick model + thinking
anvil config set thinking medium
anvil "fix the failing test in test/auth.test.ts"
anvil                                  # interactive session
anvil -c                               # resume the most recent session
anvil -r 3f2ab9c1                      # resume a specific session (prefix ok)
anvil sessions                         # list stored sessions
```

API keys can also come from environment variables (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`) or from the web UI settings dialog — see
[Configuration](#configuration) for the precedence.

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
  waiting for a permission). A search box filters the list (fuzzy: substring
  or subsequence over title and model). Sessions survive page reloads *and
  server restarts*: the `?session=<id>` deep link reopens them, and the
  transcript is replayed from the server, including a permission prompt that
  is still pending.
- **Forking** — every assistant answer carries a small fork button (hover the
  message). Clicking it — or typing `/fork` — branches the conversation at
  that point into a new, independently resumable session. The new session
  starts with a `Forked from …` note in its header.
- **File changes** — each `Write`/`Edit` renders as a collapsible card with
  the file path, a `+N/−M` stat, and a two-gutter diff (old/new line numbers,
  green/red rows, collapsed context runs). Changes made by a subagent are
  tagged. A per-turn summary chip below the answer lists the files touched
  and the input/output tokens of the turn.
- **Images** — the paperclip button (or pasting / dragging files) attaches up
  to 8 images (≤ 10 MB each) with previews; they send with the next message
  and show as thumbnails in your message bubble.
- **Export** — the export button downloads the conversation as Markdown or as
  a self-contained HTML file (the same renderer, inline CSS, no external
  assets).
- **Notifications** — toggle with the bell (or `/notify on|off`). While the
  tab is hidden, anvil raises a browser notification for permission prompts
  and when a turn finishes; the page title also flips to "⏳ anvil —
  working" while busy.
- **Slash commands** — typing `/` in the composer opens an autocomplete
  popup: `/help`, `/new`, `/fork`, `/model [name]`, `/thinking <level>`,
  `/mode <mode>`, `/export [md|html]`, `/notify [on|off]`. Navigate with
  ↑/↓, pick with Tab/Enter, dismiss with Esc.
- **Stop** — while a turn is running the send button turns red; clicking it
  (or pressing `Esc`) aborts the turn: the in-flight model call is cancelled
  and a pending permission prompt is resolved as denied.
- **Thinking** — when extended thinking is enabled, the model's reasoning
  streams into a collapsible "thinking" block (open while it runs, collapsed
  afterwards with a size badge). Thinking is also part of the transcript
  replay. The model pill in the header shows the active thinking level.
- **Settings** — the gear icon in the header opens a settings dialog:
  provider (auto/Anthropic/OpenAI), API keys (shown masked; leave untouched to
  keep the stored key, clear it to remove it), OpenAI base URL, model (with
  suggestions, free text allowed), and thinking effort. Changes are stored in
  `~/.anvil.json` and apply to new sessions.
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
| `GET` | `/api/config` | current settings; API keys masked, never raw |
| `PUT` | `/api/config` | update `provider` (`anthropic` / `openai` / `hsnr` / `local`), `model`, `thinking`, `anthropicKey`, `openaiKey`, `openaiBaseUrl`, `hsnrKey`, `hsnrBaseUrl`, `localBaseUrl` (empty string clears a field); persisted to `~/.anvil.json` |
| `GET` | `/api/local-models` | probe the local runtime (Ollama / LM Studio / `localBaseUrl`), list its models |
| `POST` | `/api/sessions` | create a session (`{ "mode", "model", "thinking" }`, all optional) |
| `GET` | `/api/sessions` | list sessions, merged from memory + disk (auto title, mode, busy, turns, usage, permission-pending) |
| `GET` | `/api/sessions/:id` | state: title, model, thinking, mode, busy, todos, usage, turns, `msgCount`, `forkedFrom`, last-turn changes, pending permission |
| `DELETE` | `/api/sessions/:id` | delete a session and its stored file (aborts a running turn first) |
| `POST` | `/api/sessions/:id/fork` | branch the session at a message (`{ "msgIndex" }`, optional; clamped off tool-call boundaries) → `201` with the new session (400 if empty, 409 if busy) |
| `GET` | `/api/sessions/:id/transcript` | renderable replay of everything that happened (incl. thinking, images, `msgIndex` fork points) |
| `POST` | `/api/sessions/:id/messages` | `{ "text": "…", "images": [{ "mediaType", "data" }] }` → starts a turn (202; ≤ 15 MB body, ≤ 8 images) |
| `POST` | `/api/sessions/:id/abort` | stop the running turn (`{ "stopped": true }`) |
| `GET` | `/api/sessions/:id/events` | SSE stream of agent events |
| `POST` | `/api/sessions/:id/permissions` | `{ "id": "perm-1", "answer": "once" }` |
| `POST` | `/api/sessions/:id/mode` | `{ "mode": "plan" }` |

SSE events: `session`, `assistant_delta`, `assistant_text` (carries a
`msgIndex` fork point), `thinking_delta`, `tool_start`, `tool_end`,
`file_change` (path, kind, `+N/−M`, line diff), `permission_request`,
`permission_resolved`, `denied`, `retry`, `error`, `aborted`, `todos`,
`turn_end` (per-turn usage + the turn's file changes + `msgCount`),
`mode_changed`.

## Local models (Ollama / LM Studio)

anvil can run on a local LLM runtime — **no API key needed**. When no key is
configured anywhere, anvil probes for a runtime and, if one is running,
resolves the provider to `local` automatically:

- Ollama at `http://127.0.0.1:11434`
- LM Studio at `http://127.0.0.1:1234`

```sh
ollama serve        # or start LM Studio's local server
anvil               # works out of the box — the first model from the
                    # runtime's list is picked (override with --model)
```

Prefer an explicit setup (or a different OpenAI-compatible server)?

```sh
anvil config set provider local
anvil config set local-base-url http://127.0.0.1:1234/v1
# or per process:  ANVIL_LOCAL_BASE_URL=http://…:8080/v1
```

The web UI settings dialog shows the detected runtime, its base URL, and its
model list (provider → “Local (Ollama / LM Studio)”). Local models force
`thinking: off` — small local models don't do extended thinking reliably.

## Offline model in the browser (WebGPU)

The **“Offline model”** button in the web UI (or `http://<host>:<port>/local-chat.html`
directly) runs a small language model **entirely in the browser** via
WebGPU — no server call, no API key, and no internet after the first
download (weights are cached in the browser's storage):

| Model | Size | Sweet spot |
| --- | --- | --- |
| `Qwen2-0.5B-Instruct` | ≈ 350 MB | phones |
| `Llama-3.2-1B-Instruct` | ≈ 750 MB | recommended |
| `Llama-3.2-3B-Instruct` | ≈ 1.7 GB | laptops/desktops |

Chat only — no tools, no file access, no terminal. It's a fast draft brain
for quick questions, not the full agent. Needs a WebGPU-capable browser
(Chrome/Edge 113+, Safari 16+, recent Firefox).

## Desktop app (Windows EXE)

The releases page ships `anvil-win-x64.exe` — a single self-contained binary
(~95 MB, bundles the Node.js runtime) with the **CLI and the web server**:
no Node install, no web folder, the UI is served from memory.

```sh
anvil-win-x64.exe server        # binds 0.0.0.0 by default (LAN-reachable)
                                # and opens the browser
anvil-win-x64.exe "fix the bug" # one-shot CLI, like the npm version
```

Build it yourself (Node ≥ 23.6, Windows):

```sh
node scripts/build-exe.mjs      # → release/anvil-win-x64.exe
```

Tip: the EXE is the easiest way to share anvil — run it on your PC, connect
your phone to the same Wi-Fi, and use the mobile app (below) or just point
the phone's browser at the printed `http://192.168.x.x:8787` URL.

## Mobile apps (Android / iOS)

From the releases page:

- **`anvil-mobile-<version>-debug.apk`** — install directly on the phone
  (allow “install unknown apps” for your file manager).
- **`anvil-mobile-<version>-unsigned.ipa`** — sideload with [AltStore](https://altstore.io/)
  or SideSync (a free Apple ID is enough; AltStore re-signs the unsigned
  build for your device).

The app has two tabs:

- **Server** — the full anvil web UI from your computer over your LAN
  (enter the address, e.g. `http://192.168.1.10:8787`; the last address is
  remembered and auto-connected).
- **Offline** — the WebGPU offline model running on the device itself.

Build them yourself:

```sh
cd mobile
npm install
npm run build:android   # → mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Requirements: Android SDK + JDK 17–21 (JDK 25 is not supported by the
template's Gradle yet). iOS needs a Mac: `npm run build:ios` then
`xcodebuild` (see `.github/workflows/mobile.yml` for the exact CI recipe).

## Configuration

Settings are resolved in this order (highest wins):

1. CLI flags / explicit API overrides
2. environment variables
3. the config file (`~/.anvil.json`, override the path with `$ANVIL_CONFIG`)
4. built-in defaults (e.g. `claude-sonnet-4-5` / `gpt-4o`) — and, if no API
   key exists anywhere, a running local runtime (Ollama / LM Studio) is
   auto-detected and becomes provider `local`

**Config file** — edited through `anvil config set <field> <value>` (also
`unset`), the web UI settings dialog, or by hand. Fields: `provider`
(`anthropic` | `openai` | `hsnr` | `local`), `model`, `thinking` (`off` |
`low` | `medium` | `high`), `anthropicKey`, `openaiKey`, `openaiBaseUrl`,
`hsnrKey`, `hsnrBaseUrl`, `localBaseUrl` (base URL of a custom
OpenAI-compatible local runtime). Keys are written with
mode `0600`; every API surface that displays them (CLI, `GET /api/config`,
UI) shows them masked.

**CLI:**

```sh
anvil config                        # show settings (keys masked)
anvil config set anthropic-key sk-ant-...
anvil config set openai-key sk-...
anvil config set hsnr-key sk-...
anvil config set model gpt-5
anvil config set thinking high
anvil config set provider local
anvil config set local-base-url http://127.0.0.1:1234/v1
anvil config unset openai-key
anvil --thinking high "explain this architecture decision"
```

**Environment variables:**

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | anthropic provider key |
| `OPENAI_API_KEY` | openai provider key |
| `OWUI_API_KEY` | hsnr provider key |
| `OPENAI_BASE_URL` | OpenAI-compatible gateway (default `https://api.openai.com/v1`) |
| `HSNR_BASE_URL` | hsnr gateway (default `https://ai.ide3.de/openai`) |
| `ANVIL_LOCAL_BASE_URL` | explicit base of a local OpenAI-compatible runtime (else Ollama / LM Studio are probed) |
| `ANVIL_MODEL` / `OPENAI_MODEL` | default model per provider |
| `ANVIL_CONFIG` | config file location (default `~/.anvil.json`) |
| `ANVIL.md` (working dir) | project memory, loaded into the prompt |
| `~/.anvil/ANVIL.md` | user memory, loaded into the prompt |

**Thinking effort** is sent only where it applies: Anthropic receives
`thinking.budget_tokens` (4k/16k/32k for low/medium/high) on thinking-capable
Claude models, OpenAI receives `reasoning_effort` on o-series/gpt-5 models,
and the hsnr gateway receives `reasoning_effort` on all of its models;
elsewhere the setting is ignored, not an error.

## Architecture

```
src/
├── index.ts            CLI: arg parsing, one-shot / interactive / server / config / sessions
├── repl.ts             interactive loop: streamed output, permission prompts, persistence
├── server.ts           REST + SSE server, sessions, forking, diffs, settings API, static web UI
├── agent.ts            the agent loop (model ⇄ tools), retry + continuation
├── permissions.ts      permission modes + ask/always/deny rules
├── prompt.ts           original system prompts + environment detection
├── config.ts           settings: ~/.anvil.json, key/model/thinking resolution
├── local.ts            Ollama / LM Studio auto-detection (probed, cached)
├── store.ts            session persistence (one JSON per session, $ANVIL_CONFIG aware)
├── diff.ts             dependency-free line diff (prefix/suffix strip + bounded LCS)
├── memory.ts           ANVIL.md loading (project + user)
├── web-assets.ts       embedded web UI (base64) for the SEA single-file exe
├── types.ts            shared types (Tool, Provider, messages, thinking, images)
├── providers/
│   ├── index.ts        provider kinds + defaults
│   ├── anthropic.ts    Messages API, SSE streaming, extended thinking, no SDK
│   └── openai.ts       chat completions, SSE streaming, reasoning_effort, image parts
└── tools/
    ├── read.ts  write.ts  edit.ts  bash.ts  glob.ts  grep.ts
    ├── todo.ts         todo list (exactly one in_progress at a time)
    ├── task.ts         subagent delegation (nested agent loop)
    └── index.ts        tool registry
bin/
└── anvil.js            npm launcher shim (npm rejects .ts bin entries)
web/
├── index.html  styles.css   dependency-free UI shell
├── app.js                ES module: live streaming markdown, file cards, images,
│                         forking, slash commands, export, notifications, search
├── local-chat.html       offline WebGPU model page (standalone, also embedded
├── local-chat.js         in the mobile app): WebLLM engine, chat, persistence
└── md.js                 isomorphic markdown + syntax highlight (browser + tests)
scripts/
├── demo-server.ts              web UI demo, no API key needed
├── build-exe.mjs               Windows EXE via Node SEA (esbuild bundle → postject)
└── sync-mobile-web.mjs         copy the offline page into the mobile app shell
mobile/                         Capacitor app shell (own package.json — the only
                                subproject with a lockfile; android/ + ios/ checked in)
test/
├── smoke.ts            agent loop, tools, permissions, diff, store, markdown (mock)
└── server-smoke.ts     HTTP server: sessions, SSE, diffs, fork, images, persistence
```

**Agent loop** (`agent.ts`): the conversation history is a plain array of
messages kept by the caller (REPL, web session, subagent). Each turn sends
`system + messages + tool schemas` to the provider; streamed text and
thinking deltas are forwarded as events. If the reply contains tool calls,
each one goes through the permission engine, is executed, and the results are
appended as `tool_result` blocks. The loop ends when the model replies with
plain text or `maxTurns` is reached. Robustness wraps each completion:
transient API errors are retried with backoff (only while nothing has been
streamed yet); a `max_tokens` cutoff — mid-answer or inside a tool call,
which the provider reports as a cutoff with no tool use — triggers an
automatic "continue where you stopped" round (a few at most); and a model
that emits tool-call arguments that are not valid JSON gets a fresh attempt
even after partial output, since no answer has been committed yet.

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

**Persistence** (`store.ts`): sessions are written as one JSON file each in
`~/.anvil/anvil-sessions/` (next to the config; `$ANVIL_CONFIG` redirects the
whole tree, which keeps tests hermetic). The server saves after create/turn/
mode/fork, merges in-memory sessions with the disk on `GET /api/sessions`
(2 s cache), and lazily adopts a stored session when it is addressed by id —
so a restart transparently reopens old conversations. The CLI persists the
same way after every turn.

**Forking**: `POST /api/sessions/:id/fork` deep-copies the history up to a
message index (clamped back past any `tool_use` message, so a fork never
straddles a dangling tool call) and records `forkedFrom { id, at }`.

**Live diffs** (`diff.ts` + `wrapFileDiff`): `Write` and `Edit` (main session
and subagents) are wrapped to snapshot the file before/after and broadcast a
`file_change` event with a line diff. The diff strips common prefix/suffix
line runs in O(n) and aligns the changed middle with an LCS DP that is capped
at 100 000 cells; the emitted diff is capped at 600 rows (250 head + gap +
250 tail) while the `+N/−M` stats always reflect the whole change.

## Design notes

- Zero runtime dependencies: `node:fs`, `node:child_process`, `node:http`,
  global `fetch`. Glob and Grep are plain TypeScript; the SSE parsers for
  both provider APIs are hand-rolled.
- Node's native TypeScript support means a checkout runs straight from source —
  no bundler, no lockfile. The npm tarball ships compiled JavaScript in
  `dist/` (built at publish time — see Development), because Node does not
  type-strip files inside `node_modules`.
- Every mutating action is either auto-approved by an explicit mode choice or
  visible to the user.

## Development

```sh
node test/smoke.ts         # agent loop, tools, permissions (no network)
node test/server-smoke.ts  # HTTP server: sessions, SSE, permission flow
node scripts/build-exe.mjs # Windows EXE (Node SEA) → release/anvil-win-x64.exe
```

### Mobile app

`mobile/` is a Capacitor subproject with its **own `package.json`** (and the
only lockfile in the repo) — the root stays dependency- and lockfile-free.
The app shell (`mobile/public/index.html`) is two iframes: the anvil server
UI over the LAN and the offline WebGPU chat page, which
`scripts/sync-mobile-web.mjs` copies from `web/` before each build.

```sh
cd mobile && npm install
npm run build:android      # debug APK (JDK 17–21 + Android SDK)
npm run build:ios          # sync only; the xcodebuild recipe lives in
                           # .github/workflows/mobile.yml
```

### Publishing

```sh
npm install          # dev-only tooling: typescript + @types/node (not shipped)
npm publish          # `prepack` compiles src/ -> dist/ into the tarball
```

## License

[MIT](./LICENSE) — original work.
