#!/usr/bin/env node
// anvil — an open-source coding agent for your terminal.

import { randomUUID } from "node:crypto"

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
import { listSessions, loadSession, saveSession, type StoredSession } from "./store.ts"
import type { Message, ThinkingEffort, ToolContext } from "./types.ts"

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"]

function usage(): void {
  console.log(`anvil — an open-source coding agent

usage:
  anvil [task...]                  one-shot: run the task and print the result
  anvil                            interactive session
  anvil -c [task...]               continue the most recent saved session
  anvil -r <id> [task...]          resume a saved session (id prefix is enough)
  anvil sessions                   list saved sessions
  anvil server [options]           start the web server (REST + SSE + web UI)
  anvil config [command]           show or change persistent settings

options:
  --provider <kind>     anthropic | openai | hsnr (default: whichever API key is set)
  --model <id>          model id (default: per-provider default, e.g. Qwen/Qwen3.8-27B for hsnr)
  --thinking <level>    off | low | medium | high (extended thinking, default: off)
  --mode <mode>         default | acceptEdits | plan | bypass (default: default)
  --max-turns <n>       agent turn limit (default: 50)
  -c, --continue        continue the most recent saved session (prefers this cwd)
  -r, --resume <id>     resume the saved session with this id (prefix matches)
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
  command: "run" | "server" | "config" | "sessions"
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
  cont: boolean
  resume: string | null
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
  let cont = false
  let resume: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "server") command = "server"
    else if (a === "sessions") command = "sessions"
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
    else if (a === "-c" || a === "--continue") cont = true
    else if (a === "-r" || a === "--resume") resume = argv[++i] ?? null
    else if (a === "-p" || a === "--print") print = true
    else if (a === "-h" || a === "--help") {
      usage()
      process.exit(0)
    } else parts.push(a)
  }
  return { command, task: parts.join(" "), provider, model, thinking, mode, maxTurns, print, port, cwd, configArgs, cont, resume }
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

async function runSessionsCommand(): Promise<void> {
  const all = await listSessions()
  if (all.length === 0) {
    console.log("no saved sessions yet — start a session or run a one-shot first")
    return
  }
  const here = process.cwd()
  const fmt = (id: string) => id.slice(0, 8)
  for (const m of all) {
    const mark = m.cwd === here ? " •" : ""
    const title = (m.title || "(untitled)").slice(0, 42)
    console.log(`${fmt(m.id)}  ${ago(m.updatedAt).padStart(9)}  ${m.model.slice(0, 26).padEnd(26)}  ${String(m.turns).padStart(3)} turns  ${title}${mark}`)
  }
  console.log(`\nresume with: anvil -r <id>   (${all.length} session${all.length === 1 ? "" : "s"} total, • = current directory)`)
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

  if (args.command === "sessions") {
    await runSessionsCommand()
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

  // Resume support: -r <id> (exact id or unique prefix) or -c (most recent
  // session, preferring one that was started in this directory).
  let stored: StoredSession | null = null
  if (args.resume) {
    stored = await loadSession(args.resume)
    if (!stored) {
      console.error(`error: no saved session matching "${args.resume}" (see: anvil sessions)`)
      process.exit(1)
    }
  } else if (args.cont) {
    const all = await listSessions()
    const pick = all.find((m) => m.cwd === workCwd) ?? all[0]
    if (!pick) {
      console.error("error: no saved sessions to continue (see: anvil sessions)")
      process.exit(1)
    }
    stored = await loadSession(pick.id)
  }

  const cwd = stored?.cwd ?? workCwd
  const env = detectEnv(cwd)
  const system = buildSystemPrompt(env, loadMemory(cwd), thinking !== "off")
  const ctx: ToolContext = { cwd, todos: stored?.todos ?? [] }
  const subagentTools = createSubagentTools()
  const sessionId = stored?.id ?? randomUUID()

  // Save after every turn — this is what makes -c / -r work later.
  const usageTotal = { input: 0, output: 0 }
  const firstUserText = (history: Message[]): string => {
    for (const m of history) {
      if (m.role !== "user") continue
      for (const b of m.content) {
        if (b.type === "text") return b.text
      }
    }
    return "(untitled)"
  }
  const persist = (history: Message[]) => {
    void saveSession({
      id: sessionId,
      title: firstUserText(history).slice(0, 64),
      kind,
      model,
      thinking,
      mode: args.mode,
      cwd,
      createdAt: stored?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      usage: { ...usageTotal },
      forkedFrom: stored?.forkedFrom ?? null,
      history,
      todos: ctx.todos,
    }).catch(() => {})
  }

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
    await startRepl({
      makeOptions,
      ctx,
      mode: args.mode,
      history: stored?.history ?? [],
      sessionId,
      onTurn: (h, u) => {
        usageTotal.input += u.input
        usageTotal.output += u.output
        persist(h)
      },
    })
    return
  }

  if (!args.task) {
    usage()
    process.exit(1)
  }

  // One-shot mode: non-interactive, so anything needing confirmation is denied
  // unless the chosen mode auto-allows it.
  const engine = new PermissionEngine(args.mode, async () => "deny", false)
  const history: Message[] = [
    ...(stored?.history ?? []),
    { role: "user", content: [{ type: "text", text: args.task }] },
  ]

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
  usageTotal.input += result.usage.input
  usageTotal.output += result.usage.output
  persist(history)
  console.error(`session: ${sessionId} — resume later with: anvil -r ${sessionId}`)
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
