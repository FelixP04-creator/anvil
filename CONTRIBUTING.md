# Contributing to anvil

anvil is small on purpose: no dependencies, no build step, no lockfile.
Keep it that way.

## Prerequisites

- Node.js **≥ 23.6** (native TypeScript type stripping)
- That's it. No `npm install`, no package manager needed.

## Running the project

```sh
node src/index.ts --help       # CLI usage
node test/smoke.ts             # agent loop + tools (no network, no API key)
node test/server-smoke.ts      # HTTP server: sessions, SSE, permission flow
```

Both test suites must pass before you push.

## House rules

- **Zero runtime dependencies.** Use `node:` builtins and global `fetch`.
  If a dependency seems necessary, discuss it first — the project's
  "read the whole thing in one evening" property matters more than any
  single feature.
- **No build step.** The source *is* the distribution. Avoid TypeScript
  features that Node's type stripping cannot handle:
  - no parameter properties (`constructor(private x: string)`)
  - no `enum`
  - no `namespace`
- **Original code only.** anvil must not include code, prompts, or assets
  from any other product.
- **Safety first.** Read-only tools stay read-only. Anything that mutates
  state (files, processes, network) must go through the permission engine.
- **Small, focused PRs.** One concern per PR. Match the existing style:
  plain functions and small classes, no abstractions until they earn them.

## Project layout

```
src/agent.ts        the agent loop (model ⇄ tools)
src/permissions.ts  permission modes + ask/always/deny rules
src/prompt.ts       system prompts + environment detection
src/memory.ts       ANVIL.md loading
src/repl.ts         interactive CLI
src/server.ts       REST + SSE server, sessions
src/providers/      anthropic.ts, openai.ts, factory
src/tools/          Read, Write, Edit, Bash, Glob, Grep, TodoWrite, Task
web/                dependency-free web UI (vanilla JS)
test/               smoke tests (mock provider, no network)
scripts/            demo-server.ts (web UI demo without an API key)
```

## Before you submit

1. Run both test suites.
2. Check `git diff --stat` — if a small feature touches more than ~15 lines
   of an unrelated module, split the PR.
3. Update `README.md` if user-facing behavior changed.

## Ideas / RFCs

Open an issue first for anything architectural (new providers, new tool
kinds, breaking API changes). Small fixes and polish can go straight to a PR.
