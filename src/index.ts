#!/usr/bin/env node
// anvil — an open-source coding agent for your terminal.

import { AnthropicProvider } from "./providers/anthropic.ts"
import { runAgent, type AgentEvent, type AgentOptions } from "./agent.ts"
import { PermissionEngine, type PermissionMode } from "./permissions.ts"
import { buildSubagentPrompt, buildSystemPrompt, detectEnv } from "./prompt.ts"
import { createMainTools, createSubagentTools } from "./tools/index.ts"
import { formatCall } from "./permissions.ts"
import { startRepl } from "./repl.ts"
import type { ToolContext } from "./types.ts"

const DEFAULT_MODEL = "claude-sonnet-4-5"

function usage(): void {
  console.log(`anvil — an open-source coding agent

usage:
  anvil [task...]             one-shot: run the task and print the result
  anvil                       interactive session
  anvil --mode acceptEdits "fix the failing test"

options:
  --model <id>                model id (default: $ANVIL_MODEL or ${DEFAULT_MODEL})
  --mode <mode>               default | acceptEdits | plan | bypass (default: default)
  --max-turns <n>             agent turn limit (default: 50)
  -p, --print                 force one-shot output even with a TTY
  -h, --help                  this help

environment:
  ANTHROPIC_API_KEY           required
  ANVIL_MODEL                 default model id`)
}

interface Args {
  task: string
  model: string
  mode: PermissionMode
  maxTurns: number
  print: boolean
}

function parseArgs(argv: string[]): Args {
  const parts: string[] = []
  let model = process.env.ANVIL_MODEL || DEFAULT_MODEL
  let mode: PermissionMode = "default"
  let maxTurns = 50
  let print = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--model") model = argv[++i] ?? model
    else if (a === "--mode") mode = (argv[++i] as PermissionMode) ?? mode
    else if (a === "--max-turns") maxTurns = parseInt(argv[++i] ?? "50", 10) || 50
    else if (a === "-p" || a === "--print") print = true
    else if (a === "-h" || a === "--help") {
      usage()
      process.exit(0)
    } else parts.push(a)
  }
  return { task: parts.join(" "), model, mode, maxTurns, print }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error("error: ANTHROPIC_API_KEY is not set. Export it and try again.")
    process.exit(1)
  }

  const workCwd = process.cwd()
  const env = detectEnv(workCwd)
  const provider = new AnthropicProvider(apiKey)
  const ctx: ToolContext = { cwd: workCwd, todos: [] }
  const subagentTools = createSubagentTools()

  const makeOptions = (engine: PermissionEngine): AgentOptions => ({
    provider,
    model: args.model,
    system: buildSystemPrompt(env),
    tools: createMainTools(ctx, {
      provider,
      model: args.model,
      subagentSystem: buildSubagentPrompt(env),
      subagentTools,
      check: (t, i) => engine.check(t, i),
      maxTurns: 30,
    }),
    permissions: engine,
    context: ctx,
    maxTurns: args.maxTurns,
  })

  const interactive = !args.task && !args.print && process.stdin.isTTY
  if (interactive) {
    await startRepl({ makeOptions, ctx, mode: args.mode })
    return
  }

  if (!args.task) {
    usage()
    process.exit(1)
  }

  // One-shot mode: non-interactive, so anything needing confirmation is denied
  // unless the chosen mode auto-allows it.
  const engine = new PermissionEngine(args.mode, async () => "deny", false)
  const onEvent = (e: AgentEvent) => {
    if (e.type === "tool_start") console.error(`[tool] ${formatCall(e.toolName ?? "", e.input)}`)
    else if (e.type === "denied") console.error(`[denied] ${e.toolName}: ${e.text}`)
    else if (e.type === "error") console.error(`[error] ${e.text}`)
  }

  const result = await runAgent(makeOptions(engine), args.task, onEvent)
  console.log(result.text)
  if (result.usage.input || result.usage.output) {
    console.error(`(tokens: ${result.usage.input} in / ${result.usage.output} out, ${result.turns} turns)`)
  }
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
