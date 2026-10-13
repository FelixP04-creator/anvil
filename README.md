# anvil

**An open-source coding agent that lives in your terminal.**

anvil is a small, readable, MIT-licensed coding agent written in plain
TypeScript (no build step, no dependencies). Point it at a task, and it reads,
edits, searches, and runs commands in your project until the task is done —
with a permission system that keeps you in control.

> anvil is an independent, original implementation. It contains no code,
> prompts, or assets from any other product, and is not affiliated with or
> endorsed by Anthropic or any other company.

## Features (v0.1)

- **Agent loop** — model proposes tool calls, anvil executes them, results go
  back to the model, until the task is complete or the turn limit is hit.
- **Core tools** — `Read`, `Write`, `Edit` (exact-match replacement), `Bash`,
  `Glob`, `Grep`, `TodoWrite`, and `Task` (subagents with their own context
  window).
- **Permission modes**
  - `default` — read-only tools run freely; anything else asks (once / always / deny)
  - `acceptEdits` — file edits auto-approved, shell still asks
  - `plan` — strictly read-only; research and planning without touching anything
  - `bypass` — no prompts (use in sandboxes only)
- **Subagents** — the `Task` tool delegates self-contained work to a fresh
  context, keeping the main conversation clean.
- **Original system prompt** — environment info, working style, safety
  guidance (prompt-injection resistance, secret hygiene), and output rules.
- **Provider interface** — the Anthropic Messages API is implemented out of the
  box; the `Provider` interface makes it easy to add others.

## Quickstart

Requires **Node.js ≥ 23.6** (runs TypeScript natively — no `tsc`, no `npm install`).

```sh
export ANTHROPIC_API_KEY=sk-ant-...

# one-shot
node src/index.ts "fix the failing test in test/auth.test.ts"

# interactive session
node src/index.ts

# let it edit files without prompting (shell still asks)
node src/index.ts --mode acceptEdits "refactor src/utils.ts"
```

Useful options:

```
--model <id>        model id (default: $ANVIL_MODEL or claude-sonnet-4-5)
--mode <mode>       default | acceptEdits | plan | bypass
--max-turns <n>     agent turn limit (default 50)
-p, --print         force one-shot output
```

In interactive mode: `/help`, `/mode <mode>`, `/todos`, `/exit`.

## Development

```sh
node test/smoke.ts   # full agent loop against a scripted mock provider (no API key needed)
```

## Architecture

```
src/
├── index.ts            CLI entry: arg parsing, one-shot vs interactive
├── repl.ts             interactive loop + permission prompts
├── agent.ts            the agent loop (model ⇄ tools)
├── permissions.ts      permission modes, ask-once/always/deny rules
├── prompt.ts           original system prompts + environment detection
├── types.ts            shared types (Tool, Provider, messages)
├── providers/
│   └── anthropic.ts    Anthropic Messages API client (fetch, no SDK)
└── tools/
    ├── read.ts  write.ts  edit.ts  bash.ts  glob.ts  grep.ts  todo.ts
    ├── task.ts         subagent delegation
    └── index.ts        tool registry
test/
└── smoke.ts            end-to-end loop test with a mock provider
```

**Agent loop** (`agent.ts`): send `system + messages + tool schemas` to the
provider. If the reply contains tool calls, check each one through the
permission engine, execute it, and append the results as `tool_result` blocks.
Repeat until the model replies with plain text or `maxTurns` is reached.

**Permissions** (`permissions.ts`): read-only tools never ask. Non-read-only
tools follow the mode; in `default` mode every new tool (or, for Bash, every
new two-word command prefix) prompts the user, with `a` remembering the choice
for the session.

**Subagents** (`tools/task.ts`): `Task` starts a nested `runAgent` with the
subagent prompt and the core tools (no `Task` itself, so no recursion). The
parent gets a concise report back.

## Design notes

- No dependencies: `node:fs`, `node:child_process`, `node:path`, global
  `fetch`. Glob and Grep are implemented in ~100 lines of plain TypeScript.
- Every tool call is either auto-allowed by design (read-only) or visible to
  the user; one-shot mode is safe by default (denies anything that would ask).
- Bash runs a fresh shell per call (no persistent state); on Windows it uses
  `powershell -NoProfile`, elsewhere `sh -c`. Output is capped at 30 KB.

## License

[MIT](./LICENSE) — original work.
