#!/usr/bin/env node
// anvil — an open-source coding agent for your terminal.

import { runAgent, type AgentEvent, type AgentOptions } from "./agent.ts"
import { PermissionEngine, type PermissionMode, formatCall } from "./permissions.ts"
import { createProvider, defaultModelFor, type ProviderKind } from "./providers/index.ts"
import { buildSubagentPrompt, buildSystemPrompt, detectEnv } from "./prompt.ts"
import { loadMemory } from "./memory.ts"
import { createMainTools, createSubagentTools } from "./tools/index.ts"
import { startRepl } from "./repl.ts"
import { AnvilServer } from "./server.ts"
import type { Message, ToolContext } from "./types.ts"

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"]

function usage(): void {
  console.log(`anvil — an open-source coding agent

usage:
  anvil [task...]                  one-shot: run the task and print the result
  anvil                            interactive session
  anvil server [options]           start the web server (REST + SSE + web UI)

options:
  --provider <kind>     anthropic | openai (default: whichever API key is set)
  --model <id>          model id (default: $ANVIL_MODEL / $OPENAI_MODEL or per-provider default)
  --mode <mode>         default | acceptEdits | plan | bypass (default: default)
  --max-turns <n>       agent turn limit (default: 50)
  -p, --print           force one-shot output even with a TTY
  -h, --help            this help

server options:
  --port <n>            port for "anvil server" (default: 8787)
  --cwd <dir>           working directory for "anvil server" (default: current)

environment:
  ANTHROPIC_API_KEY     required for the anthropic provider
  OPENAI_API_KEY        required for the openai provider
  OPENAI_BASE_URL       OpenAI-compatible gateway base (default: https://api.openai.com/v1)
  ANVIL_MODEL           default model for the anthropic provider
  OPENAI_MODEL          default model for the openai provider`)
}

interface Args {
  command: "run" | "server"
  task: string
  provider: ProviderKind | undefined
  model: string
  mode: PermissionMode
  maxTurns: number
  print: boolean
  port: number
  cwd: string
}

function parseArgs(argv: string[]): Args {
  const parts: string[] = []
  let command: Args["command"] = "run"
  let provider: ProviderKind | undefined
  let model = ""
  let mode: PermissionMode = "default"
  let maxTurns = 50
  let print = false
  let port = 8787
  let cwd = process.cwd()

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "server") command = "server"
    else if (a === "--provider") provider = (argv[++i] as ProviderKind) ?? provider
    else if (a === "--model") model = argv[++i] ?? model
    else if (a === "--mode") mode = (argv[++i] as PermissionMode) ?? mode
    else if (a === "--max-turns") maxTurns = parseInt(argv[++i] ?? "50", 10) || 50
    else if (a === "--port") port = parseInt(argv[++i] ?? "8787", 10) || 8787
    else if (a === "--cwd") cwd = argv[++i] ?? cwd
    else if (a === "-p" || a === "--print") print = true
    else if (a === "-h" || a === "--help") {
      usage()
      process.exit(0)
    } else parts.push(a)
  }
  return { command, task: parts.join(" "), provider, model, mode, maxTurns, print, port, cwd }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!MODES.includes(args.mode)) {
    console.error(`error: unknown mode "${args.mode}" (use: ${MODES.join(", ")})`)
    process.exit(1)
  }

  const { provider, kind } = createProvider(args.provider)
  const model = args.model || defaultModelFor(kind)

  if (args.command === "server") {
    const server = new AnvilServer({ provider, model, cwd: args.cwd })
    const port = await server.listen(args.port)
    console.log(`anvil server listening on http://localhost:${port}`)
    console.log(`  web UI:  http://localhost:${port}`)
    console.log(`  model:   ${model} (${kind})`)
    console.log(`  cwd:     ${args.cwd}`)
    return
  }

  const workCwd = process.cwd()
  const env = detectEnv(workCwd)
  const system = buildSystemPrompt(env, loadMemory(workCwd))
  const ctx: ToolContext = { cwd: workCwd, todos: [] }
  const subagentTools = createSubagentTools()

  const makeOptions = (engine: PermissionEngine): AgentOptions => ({
    provider,
    model,
    system,
    tools: createMainTools(ctx, {
      provider,
      model,
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
  const history: Message[] = [{ role: "user", content: [{ type: "text", text: args.task }] }]

  let streamed = false
  const onEvent = (e: AgentEvent) => {
    if (e.type === "assistant_delta") {
      streamed = true
      process.stdout.write(e.text ?? "")
    } else if (e.type === "tool_start") {
      console.error(`[tool] ${formatCall(e.toolName ?? "", e.input)}`)
    } else if (e.type === "denied") {
      console.error(`[denied] ${e.toolName}: ${e.text}`)
    } else if (e.type === "error") {
      console.error(`[error] ${e.text}`)
    }
  }

  const result = await runAgent({ ...makeOptions(engine), onEvent }, history)
  if (streamed) console.log()
  else if (result.text) console.log(result.text)
  if (result.usage.input || result.usage.output) {
    console.error(`(tokens: ${result.usage.input} in / ${result.usage.output} out, ${result.turns} turns)`)
  }
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
