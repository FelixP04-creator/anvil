#!/usr/bin/env node
// anvil — an open-source coding agent for your terminal.

import { runAgent, type AgentEvent, type AgentOptions } from "./agent.ts"
import { PermissionEngine, type PermissionMode, formatCall } from "./permissions.ts"
import { type ProviderKind } from "./providers/index.ts"
import {
  THINKING_LEVELS,
  configPath,
  loadConfig,
  maskKey,
  resolveSettings,
  saveConfig,
  type FileConfig,
} from "./config.ts"
import { buildSubagentPrompt, buildSystemPrompt, detectEnv } from "./prompt.ts"
import { loadMemory } from "./memory.ts"
import { createMainTools, createSubagentTools } from "./tools/index.ts"
import { startRepl } from "./repl.ts"
import { AnvilServer } from "./server.ts"
import type { Message, ThinkingEffort, ToolContext } from "./types.ts"

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"]

function usage(): void {
  console.log(`anvil — an open-source coding agent

usage:
  anvil [task...]                  one-shot: run the task and print the result
  anvil                            interactive session
  anvil server [options]           start the web server (REST + SSE + web UI)
  anvil config [command]           show or change persistent settings

options:
  --provider <kind>     anthropic | openai | hsnr (default: whichever API key is set)
  --model <id>          model id (default: per-provider default, e.g. Qwen/Qwen3.8-27B for hsnr)
  --thinking <level>    off | low | medium | high (extended thinking, default: off)
  --mode <mode>         default | acceptEdits | plan | bypass (default: default)
  --max-turns <n>       agent turn limit (default: 50)
  -p, --print           force one-shot output even with a TTY
  -h, --help            this help

server options:
  --port <n>            port for "anvil server" (default: 8787)
  --cwd <dir>           working directory for "anvil server" (default: current)

config commands:
  anvil config                       show settings (keys masked)
  anvil config set <field> <value>   set provider | model | thinking |
                                     anthropic-key | openai-key | openai-base-url |
                                     hsnr-key | hsnr-base-url
  anvil config unset <field>         remove a field

settings are stored in ~/.anvil.json. Resolution order:
  CLI flags > environment > config file > defaults

environment:
  ANTHROPIC_API_KEY     API key for the anthropic provider
  OPENAI_API_KEY        API key for the openai provider
  OWUI_API_KEY          API key for the hsnr provider
  OPENAI_BASE_URL       OpenAI-compatible gateway base (default: https://api.openai.com/v1)
  HSNR_BASE_URL         hsnr gateway base (default: https://ai.ide3.de/openai)
  ANVIL_MODEL           default model for the anthropic/hsnr provider
  OPENAI_MODEL          default model for the openai provider
  ANVIL_CONFIG          config file location (default: ~/.anvil.json)`)
}

const CONFIG_FIELDS = [
  "provider",
  "model",
  "thinking",
  "anthropic-key",
  "openai-key",
  "openai-base-url",
  "hsnr-key",
  "hsnr-base-url",
] as const
type ConfigField = (typeof CONFIG_FIELDS)[number]

function fieldToKey(field: ConfigField): keyof FileConfig {
  if (field === "anthropic-key") return "anthropicKey"
  if (field === "openai-key") return "openaiKey"
  if (field === "openai-base-url") return "openaiBaseUrl"
  if (field === "hsnr-key") return "hsnrKey"
  if (field === "hsnr-base-url") return "hsnrBaseUrl"
  return field
}

function runConfigCommand(args: string[]): void {
  const [cmd, field, ...rest] = args
  if (!cmd || cmd === "show") {
    const file = loadConfig()
    const line = (label: string, value: string | undefined, masked: boolean) => {
      console.log(`  ${label.padEnd(16)} ${value ? (masked ? maskKey(value) : value) : "—"}`)
    }
    console.log(`config file: ${configPath()}`)
    console.log("")
    line("provider", file.provider, false)
    line("model", file.model, false)
    line("thinking", file.thinking, false)
    line("anthropic-key", file.anthropicKey, true)
    line("openai-key", file.openaiKey, true)
    line("openai-base-url", file.openaiBaseUrl, false)
    line("hsnr-key", file.hsnrKey, true)
    line("hsnr-base-url", file.hsnrBaseUrl, false)
    console.log("")
    try {
      const s = resolveSettings()
      console.log(`resolved:     ${s.kind} / ${s.model} / thinking: ${s.thinking}`)
    } catch (err) {
      console.log(`resolved:     ${String(err)}`)
    }
    return
  }
  if (cmd === "set" || cmd === "unset") {
    if (!field || !CONFIG_FIELDS.includes(field as ConfigField)) {
      console.error(`usage: anvil config ${cmd} <${CONFIG_FIELDS.join(" | ")}> [value]`)
      process.exit(1)
    }
    const key = fieldToKey(field as ConfigField)
    if (cmd === "unset") {
      saveConfig({ [key]: undefined })
      console.log(`cleared: ${field}`)
      return
    }
    const value = rest.join(" ")
    if (!value) {
      console.error(`usage: anvil config set ${field} <value>`)
      process.exit(1)
    }
    if (
      field === "provider" &&
      value !== "anthropic" &&
      value !== "openai" &&
      value !== "hsnr"
    ) {
      console.error(`provider must be one of: anthropic | openai | hsnr`)
      process.exit(1)
    }
    if (field === "thinking" && !THINKING_LEVELS.includes(value as ThinkingEffort)) {
      console.error(`thinking must be one of: ${THINKING_LEVELS.join(" | ")}`)
      process.exit(1)
    }
    saveConfig({ [key]: value })
    console.log(`saved: ${field} → ${field.includes("key") ? maskKey(value) : value}`)
    return
  }
  console.error(`unknown config command: ${cmd} (try: anvil config, set, unset)`)
  process.exit(1)
}

interface Args {
  command: "run" | "server" | "config"
  task: string
  provider: ProviderKind | undefined
  model: string
  thinking: ThinkingEffort | undefined
  mode: PermissionMode
  maxTurns: number
  print: boolean
  port: number
  cwd: string
  configArgs: string[]
}

function parseArgs(argv: string[]): Args {
  const parts: string[] = []
  const configArgs: string[] = []
  let command: Args["command"] = "run"
  let provider: ProviderKind | undefined
  let model = ""
  let thinking: ThinkingEffort | undefined
  let mode: PermissionMode = "default"
  let maxTurns = 50
  let print = false
  let port = 8787
  let cwd = process.cwd()

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "server") command = "server"
    else if (a === "config") {
      command = "config"
      configArgs.push(...argv.slice(i + 1))
      i = argv.length
    } else if (a === "--provider") provider = (argv[++i] as ProviderKind) ?? provider
    else if (a === "--model") model = argv[++i] ?? model
    else if (a === "--thinking") thinking = (argv[++i] as ThinkingEffort) ?? thinking
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
  return { command, task: parts.join(" "), provider, model, thinking, mode, maxTurns, print, port, cwd, configArgs }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!MODES.includes(args.mode)) {
    console.error(`error: unknown mode "${args.mode}" (use: ${MODES.join(", ")})`)
    process.exit(1)
  }
  if (args.thinking && !THINKING_LEVELS.includes(args.thinking)) {
    console.error(`error: unknown thinking level "${args.thinking}" (use: ${THINKING_LEVELS.join(", ")})`)
    process.exit(1)
  }

  if (args.command === "config") {
    runConfigCommand(args.configArgs)
    return
  }

  const settings = resolveSettings({ provider: args.provider, model: args.model || undefined, thinking: args.thinking })
  const { provider, kind, model, thinking } = settings

  if (args.command === "server") {
    const server = new AnvilServer(
      { provider, kind, model, thinking, cwd: args.cwd },
      settings,
    )
    const port = await server.listen(args.port)
    console.log(`anvil server listening on http://localhost:${port}`)
    console.log(`  web UI:  http://localhost:${port}`)
    console.log(`  model:   ${model} (${kind}, thinking: ${thinking})`)
    console.log(`  cwd:     ${args.cwd}`)
    console.log(`  keys:    config file ${configPath()} or environment variables`)
    return
  }

  const workCwd = process.cwd()
  const env = detectEnv(workCwd)
  const system = buildSystemPrompt(env, loadMemory(workCwd), thinking !== "off")
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
    thinking,
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
  let thought = false
  const onEvent = (e: AgentEvent) => {
    if (e.type === "thinking_delta") {
      if (!thought) {
        thought = true
        process.stderr.write("\nthinking…\n")
      }
    } else if (e.type === "assistant_delta") {
      if (thought) {
        process.stderr.write("\n")
        thought = false
      }
      streamed = true
      process.stdout.write(e.text ?? "")
    } else if (e.type === "tool_start") {
      console.error(`[tool] ${formatCall(e.toolName ?? "", e.input)}`)
    } else if (e.type === "denied") {
      console.error(`[denied] ${e.toolName}: ${e.text}`)
    } else if (e.type === "retry") {
      console.error(`[retry] ${e.text}`)
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
