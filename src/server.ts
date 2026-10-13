// HTTP server: REST + SSE API over agent sessions, plus the web UI.
// Zero dependencies — plain node:http.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"

import { runAgent } from "./agent.ts"
import { PermissionEngine, type AskAnswer, type AskFn, type PermissionMode } from "./permissions.ts"
import { buildSubagentPrompt, buildSystemPrompt, detectEnv } from "./prompt.ts"
import { loadMemory } from "./memory.ts"
import { createMainTools, createSubagentTools } from "./tools/index.ts"
import {
  THINKING_LEVELS,
  configPath,
  loadConfig,
  maskKey,
  resolveSettings,
  saveConfig,
  type FileConfig,
  type ResolvedSettings,
} from "./config.ts"
import type { ProviderKind } from "./providers/index.ts"
import type { Message, Provider, ThinkingEffort, ToolContext, Tool, ToolInput } from "./types.ts"

export const VERSION = "0.5.2"
export const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"]
export const THINKING: ThinkingEffort[] = THINKING_LEVELS

export interface ServerConfig {
  provider: Provider
  kind: ProviderKind
  model: string
  thinking: ThinkingEffort
  cwd: string
  maxTurns?: number
}

/** What GET /api/config returns (keys are masked, never raw). */
interface ConfigView {
  provider: ProviderKind
  model: string
  thinking: ThinkingEffort
  hasAnthropicKey: boolean
  hasOpenaiKey: boolean
  hasHsnrKey: boolean
  anthropicKey: string | null
  openaiKey: string | null
  hsnrKey: string | null
  openaiBaseUrl: string | null
  hsnrBaseUrl: string | null
  configPath: string
}

export type ServerEvent = { type: string } & Record<string, unknown>

export type TranscriptEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "thinking"; text: string }
  | { role: "tool"; name: string; args: ToolInput; ok: boolean; output: string; pending?: boolean }

/**
 * One web/CLI session: owns the conversation history, tool context and
 * permission engine. Permission prompts suspend the turn as a pending
 * promise and are answered through the API (or resolve immediately for
 * auto-allowed actions).
 */
export class Session {
  id: string
  cwd: string
  kind: ProviderKind
  model: string
  thinking: ThinkingEffort
  ctx: ToolContext
  history: Message[]
  engine: PermissionEngine
  busy = false
  createdAt = Date.now()
  usage = { input: 0, output: 0 }

  private listeners = new Set<(e: ServerEvent) => void>()
  private pendingPermissions = new Map<
    string,
    { resolve: (a: AskAnswer) => void; toolName: string; detail: string; input: ToolInput }
  >()
  private permissionCounter = 0
  private tools: Tool[]
  private provider: Provider
  private system: string
  private maxTurns: number
  private abortController: AbortController | null = null
  private lastTodosSig = ""
  /** Tool results of the current turn that executed but are not in the
   *  history yet (the turn is suspended between tool calls). */
  private completedTools: { ok: boolean; output: string }[] = []

  constructor(id: string, config: ServerConfig, mode: PermissionMode, overrides?: { model?: string; thinking?: ThinkingEffort }) {
    this.id = id
    this.cwd = config.cwd
    this.kind = config.kind
    this.model = overrides?.model || config.model
    this.thinking = overrides?.thinking ?? config.thinking
    this.provider = config.provider
    this.maxTurns = config.maxTurns ?? 50
    this.ctx = { cwd: config.cwd, todos: [] }
    this.history = []

    const env = detectEnv(config.cwd)
    this.system = buildSystemPrompt(env, loadMemory(config.cwd), this.thinking !== "off")

    const ask: AskFn = (toolName, input, detail) =>
      new Promise<AskAnswer>((resolve) => {
        const permId = `perm-${++this.permissionCounter}`
        this.pendingPermissions.set(permId, { resolve, toolName, detail, input })
        this.broadcast({ type: "permission_request", id: permId, toolName, detail, input })
      })
    this.engine = new PermissionEngine(mode, ask, true)

    this.tools = this.buildTools(env)
  }

  private buildTools(env: ReturnType<typeof detectEnv>): Tool[] {
    return createMainTools(this.ctx, {
      provider: this.provider,
      model: this.model,
      subagentSystem: buildSubagentPrompt(env),
      subagentTools: createSubagentTools(),
      check: (t, i) => this.engine.check(t, i),
      maxTurns: 30,
    })
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  broadcast(e: ServerEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e)
      } catch {
        // A failing subscriber must not kill the running turn.
      }
    }
  }

  answerPermission(permId: string, answer: AskAnswer): boolean {
    const pending = this.pendingPermissions.get(permId)
    if (!pending) return false
    this.pendingPermissions.delete(permId)
    pending.resolve(answer)
    // Let other connected clients (second tab, phone) dismiss the card too.
    this.broadcast({ type: "permission_resolved", id: permId, answer })
    return true
  }

  /**
   * Stop the running turn: cancels the in-flight model call and treats any
   * pending permission prompt as denied. No-op when nothing is running.
   */
  abort(): boolean {
    if (!this.busy) return false
    this.abortController?.abort()
    for (const [permId, p] of this.pendingPermissions) {
      p.resolve("deny")
      this.broadcast({ type: "permission_resolved", id: permId, answer: "stopped" })
    }
    this.pendingPermissions.clear()
    return true
  }

  /** Auto title: the first user message, trimmed to one line. */
  get title(): string {
    for (const m of this.history) {
      if (m.role !== "user") continue
      for (const b of m.content) {
        if (b.type === "text") {
          const t = b.text.replace(/\s+/g, " ").trim()
          if (t) return t.length > 64 ? t.slice(0, 64).trimEnd() + "…" : t
        }
      }
    }
    return "New session"
  }

  setMode(mode: PermissionMode): void {
    this.engine.mode = mode
    this.broadcast({ type: "mode_changed", mode })
  }

  /**
   * Switch the model and/or thinking level mid-conversation. Takes effect
   * from the next turn (an in-flight turn keeps the old settings); the
   * system prompt and subagent tools are rebuilt to match.
   */
  updateOverrides(model: string | undefined, thinking: ThinkingEffort | undefined): void {
    if (model) this.model = model
    if (thinking) this.thinking = thinking
    const env = detectEnv(this.cwd)
    this.system = buildSystemPrompt(env, loadMemory(this.cwd), this.thinking !== "off")
    this.tools = this.buildTools(env)
  }

  state() {
    const pending = [...this.pendingPermissions.entries()]
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      kind: this.kind,
      model: this.model,
      thinking: this.thinking,
      mode: this.engine.mode,
      busy: this.busy,
      todos: this.ctx.todos,
      usage: this.usage,
      createdAt: this.createdAt,
      turns: this.history.filter(
        (m) => m.role === "user" && m.content.some((b) => b.type === "text"),
      ).length,
      // Included in the SSE "session" snapshot so (re)connecting clients can
      // re-render an unanswered permission prompt.
      pendingPermission: pending.length
        ? {
            id: pending[0][0],
            toolName: pending[0][1].toolName,
            detail: pending[0][1].detail,
            input: pending[0][1].input,
          }
        : null,
    }
  }

  /**
   * Compact, renderable view of everything that happened so far — used by
   * the web UI to replay a session after a page load.
   */
  transcript(): TranscriptEntry[] {
    const out: TranscriptEntry[] = []
    const filled = new Set<number>()
    for (const m of this.history) {
      if (m.role === "assistant") {
        // Preserve the order within the response: optional thinking first,
        // then text before the tool calls it introduces, then trailing text.
        let pre = ""
        let post = ""
        let thought = ""
        let toolCount = 0
        for (const b of m.content) {
          if (b.type === "text") {
            if (toolCount === 0) pre += b.text
            else post += b.text
          } else if (b.type === "thinking") {
            thought += b.text
          } else if (b.type === "tool_use") {
            if (thought) {
              out.push({ role: "thinking", text: thought })
              thought = ""
            }
            if (pre) {
              out.push({ role: "assistant", text: pre })
              pre = ""
            }
            toolCount++
            out.push({ role: "tool", name: b.name, args: b.input ?? {}, ok: false, output: "" })
          }
        }
        if (thought) out.push({ role: "thinking", text: thought })
        if (pre) out.push({ role: "assistant", text: pre })
        if (post) out.push({ role: "assistant", text: post })
      } else {
        for (const b of m.content) {
          if (b.type === "text") out.push({ role: "user", text: b.text })
          else if (b.type === "tool_result") {
            for (let i = out.length - 1; i >= 0; i--) {
              const e = out[i]
              if (e.role === "tool" && !filled.has(i)) {
                e.ok = !b.is_error
                e.output = b.content
                filled.add(i)
                break
              }
            }
          }
        }
      }
    }
    // A suspended turn has executed some tools whose results are not in
    // the history yet — fill those in (in order) before marking the rest
    // as pending.
    let ci = 0
    for (let i = 0; i < out.length; i++) {
      const e = out[i]
      if (e.role === "tool" && !filled.has(i) && ci < this.completedTools.length) {
        e.ok = this.completedTools[ci].ok
        e.output = this.completedTools[ci].output
        filled.add(i)
        ci++
      }
    }
    // Tool calls without a result yet are still running (or waiting at a
    // permission prompt).
    for (let i = 0; i < out.length; i++) {
      const e = out[i]
      if (e.role === "tool" && !filled.has(i)) e.pending = true
    }
    return out
  }

  async send(text: string): Promise<void> {
    if (this.busy) throw new Error("session is busy with another turn")
    this.busy = true
    this.history.push({ role: "user", content: [{ type: "text", text }] })
    const ac = new AbortController()
    this.abortController = ac
    try {
      const result = await runAgent(
        {
          provider: this.provider,
          model: this.model,
          system: this.system,
          tools: this.tools,
          permissions: this.engine,
          context: this.ctx,
          maxTurns: this.maxTurns,
          thinking: this.thinking,
          signal: ac.signal,
          onEvent: (e) => {
            if (e.type === "tool_end") {
              // Remember for transcript() — results only land in the
              // history once the whole model response has been processed.
              this.completedTools.push({ ok: !!e.ok, output: String(e.text ?? "") })
              const sig = JSON.stringify(this.ctx.todos)
              if (sig !== this.lastTodosSig) {
                this.lastTodosSig = sig
                this.broadcast({ type: "todos", todos: this.ctx.todos })
              }
            }
            this.broadcast({ ...e })
          },
        },
        this.history,
      )
      this.usage.input += result.usage.input
      this.usage.output += result.usage.output
    } finally {
      this.busy = false
      this.abortController = null
      this.completedTools = []
      this.broadcast({ type: "turn_end" })
    }
  }
}

export class AnvilServer {
  sessions = new Map<string, Session>()
  private server: Server | null = null
  private webRoot: string
  private config: ServerConfig
  private settings: ResolvedSettings | null

  constructor(config: ServerConfig, settings?: ResolvedSettings) {
    this.config = config
    try {
      this.settings = settings ?? resolveSettings()
    } catch {
      // No keys resolvable (mock/demo setup) — settings still work via the
      // config file once the user stores keys.
      this.settings = settings ?? null
    }
    const here = dirname(fileURLToPath(import.meta.url))
    this.webRoot = normalize(join(here, "..", "web"))
  }

  private configView(): ConfigView {
    const file = loadConfig()
    const anthropicKey = process.env.ANTHROPIC_API_KEY || file.anthropicKey
    const openaiKey = process.env.OPENAI_API_KEY || file.openaiKey
    const hsnrKey = process.env.OWUI_API_KEY || file.hsnrKey
    const s = this.settings
    return {
      provider:
        s?.kind ??
        (file.provider ||
          (anthropicKey ? "anthropic" : openaiKey ? "openai" : hsnrKey ? "hsnr" : this.config.kind)),
      model: s?.model ?? (file.model || this.config.model),
      thinking: s?.thinking ?? (file.thinking ?? this.config.thinking),
      hasAnthropicKey: Boolean(anthropicKey),
      hasOpenaiKey: Boolean(openaiKey),
      hasHsnrKey: Boolean(hsnrKey),
      anthropicKey: maskKey(anthropicKey),
      openaiKey: maskKey(openaiKey),
      hsnrKey: maskKey(hsnrKey),
      openaiBaseUrl: process.env.OPENAI_BASE_URL || file.openaiBaseUrl || null,
      hsnrBaseUrl: process.env.HSNR_BASE_URL || file.hsnrBaseUrl || null,
      configPath: configPath(),
    }
  }

  /** Start listening; returns the actual port (pass 0 for an ephemeral one). */
  async listen(port = 8787): Promise<number> {
    const http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: String(err) })
      })
    })
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject)
      http.listen(port, "127.0.0.1", () => resolve())
    })
    this.server = http
    const addr = http.address()
    return typeof addr === "object" && addr ? addr.port : port
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server.closeAllConnections()
      resolve()
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname
    const method = req.method ?? "GET"

    if (path.startsWith("/api/")) {
      if (method === "GET" && path === "/api/health") {
        return json(res, 200, { ok: true, version: VERSION })
      }

      if (method === "GET" && path === "/api/config") {
        return json(res, 200, this.configView())
      }

      if (method === "PUT" && path === "/api/config") {
        const body = (await readJson(req)) ?? {}
        const str = (k: string): string | undefined =>
          typeof body[k] === "string" ? (body[k] as string).trim() : undefined
        const patch: Partial<FileConfig> = {}
        const provider = str("provider")
        if (provider !== undefined) {
          if (provider !== "" && provider !== "anthropic" && provider !== "openai" && provider !== "hsnr") {
            return json(res, 400, { error: "provider must be one of: anthropic | openai | hsnr (or empty to auto-detect)" })
          }
          patch.provider = (provider || undefined) as ProviderKind
        }
        const model = str("model")
        if (model !== undefined) patch.model = model
        const thinking = str("thinking")
        if (thinking !== undefined) {
          if (!THINKING_LEVELS.includes(thinking as ThinkingEffort)) {
            return json(res, 400, { error: `thinking must be one of: ${THINKING_LEVELS.join(" | ")}` })
          }
          patch.thinking = thinking as ThinkingEffort
        }
        const anthropicKey = str("anthropicKey")
        if (anthropicKey !== undefined) patch.anthropicKey = anthropicKey
        const openaiKey = str("openaiKey")
        if (openaiKey !== undefined) patch.openaiKey = openaiKey
        const baseUrl = str("openaiBaseUrl")
        if (baseUrl !== undefined) patch.openaiBaseUrl = baseUrl
        const hsnrKey = str("hsnrKey")
        if (hsnrKey !== undefined) patch.hsnrKey = hsnrKey
        const hsnrBase = str("hsnrBaseUrl")
        if (hsnrBase !== undefined) patch.hsnrBaseUrl = hsnrBase

        saveConfig(patch)
        // Re-resolve the provider. When no API key is resolvable at all
        // (e.g. a mock/demo server) the settings are still saved — model and
        // thinking become active as soon as a key exists.
        let note = "settings apply to new sessions"
        try {
          const s = resolveSettings()
          this.settings = s
          this.config = {
            provider: s.provider,
            kind: s.kind,
            model: s.model,
            thinking: s.thinking,
            cwd: this.config.cwd,
            maxTurns: this.config.maxTurns,
          }
        } catch {
          this.settings = null
          const file = loadConfig()
          this.config = {
            ...this.config,
            model: file.model || this.config.model,
            thinking: file.thinking ?? this.config.thinking,
          }
          note = "saved — no usable API key found yet, so the settings are not active"
        }
        return json(res, 200, { ok: true, note, config: this.configView() })
      }

      if (method === "POST" && path === "/api/sessions") {
        const body = (await readJson(req)) ?? {}
        const id = randomUUID()
        const requested = body.mode as PermissionMode | undefined
        const mode: PermissionMode = requested && MODES.includes(requested) ? requested : "default"
        const thinkingReq = body.thinking as ThinkingEffort | undefined
        const thinking = thinkingReq && THINKING_LEVELS.includes(thinkingReq) ? thinkingReq : undefined
        const modelReq = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined
        const session = new Session(id, this.config, mode, { model: modelReq, thinking })
        this.sessions.set(id, session)
        return json(res, 201, {
          id,
          cwd: this.config.cwd,
          model: session.model,
          thinking: session.thinking,
          mode,
        })
      }

      if (method === "GET" && path === "/api/sessions") {
        const sessions = [...this.sessions.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((s) => {
            const st = s.state()
            return {
              id: s.id,
              title: st.title,
              mode: st.mode,
              busy: st.busy,
              turns: st.turns,
              createdAt: s.createdAt,
              needsPermission: st.pendingPermission !== null,
            }
          })
        return json(res, 200, { sessions })
      }

      const m = path.match(
        /^\/api\/sessions\/([^/]+)(?:\/(messages|events|permissions|mode|transcript|abort))?$/,
      )
      if (m) {
        const session = this.sessions.get(m[1])
        if (!session) return json(res, 404, { error: "unknown session" })
        const sub = m[2]

        if (method === "GET" && !sub) return json(res, 200, session.state())

        if (method === "DELETE" && !sub) {
          session.abort()
          this.sessions.delete(m[1])
          return json(res, 200, { ok: true })
        }

        if (method === "PATCH" && !sub) {
          const body = (await readJson(req)) ?? {}
          const model = body.model === undefined ? undefined : String(body.model).trim()
          const thinking = body.thinking
          if (model === undefined && thinking === undefined) {
            return json(res, 400, { error: "provide model and/or thinking" })
          }
          if (model !== undefined && !model) {
            return json(res, 400, { error: "model must be a non-empty string" })
          }
          if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingEffort)) {
            return json(res, 400, { error: `thinking must be one of: ${THINKING_LEVELS.join(" | ")}` })
          }
          session.updateOverrides(model, thinking as ThinkingEffort | undefined)
          const state = session.state()
          session.broadcast({ type: "session", ...state })
          return json(res, 200, state)
        }

        if (method === "POST" && sub === "abort") {
          return json(res, 200, { stopped: session.abort() })
        }

        if (method === "GET" && sub === "transcript") {
          return json(res, 200, { entries: session.transcript() })
        }

        if (method === "GET" && sub === "events") return this.handleEvents(req, res, session)

        if (method === "POST" && sub === "messages") {
          const body = await readJson(req)
          const text = typeof body?.text === "string" ? body.text : ""
          if (!text) return json(res, 400, { error: "text is required" })
          if (session.busy) return json(res, 409, { error: "session is busy with another turn" })
          session.send(text).catch((err) => {
            session.broadcast({ type: "error", text: String(err) })
          })
          return json(res, 202, { started: true })
        }

        if (method === "POST" && sub === "permissions") {
          const body = await readJson(req)
          const id = typeof body?.id === "string" ? body.id : ""
          const answer = body?.answer
          if (answer !== "once" && answer !== "always" && answer !== "deny") {
            return json(res, 400, { error: "answer must be one of: once | always | deny" })
          }
          const ok = session.answerPermission(id, answer)
          return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "unknown permission id" })
        }

        if (method === "POST" && sub === "mode") {
          const body = await readJson(req)
          const requested = body?.mode as PermissionMode | undefined
          if (!requested || !MODES.includes(requested)) return json(res, 400, { error: `mode must be one of: ${MODES.join(" | ")}` })
          session.setMode(requested)
          return json(res, 200, { ok: true })
        }
      }

      return json(res, 404, { error: "not found" })
    }

    if (method === "GET") return this.serveStatic(res, path)
    json(res, 405, { error: "method not allowed" })
  }

  /** SSE stream of all session events; subscribes before responding to avoid races. */
  private handleEvents(req: IncomingMessage, res: ServerResponse, session: Session): void {
    const unsubscribe = session.subscribe((e) => {
      if (!res.writableEnded) res.write(sse(e))
    })
    req.on("close", unsubscribe)
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    })
    res.write("retry: 2000\n\n")
    // State snapshot so (re)connecting clients can re-sync.
    res.write(sse({ type: "session", ...session.state() }))
  }

  private serveStatic(res: ServerResponse, urlPath: string): void {
    const name = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "")
    const full = normalize(join(this.webRoot, name))
    if (!full.startsWith(this.webRoot) || !existsSync(full)) {
      json(res, 404, { error: "not found" })
      return
    }
    const ext = full.slice(full.lastIndexOf("."))
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".json": "application/json; charset=utf-8",
    }
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" })
    res.end(readFileSync(full))
  }
}

function sse(e: ServerEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) })
  res.end(data)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1_000_000) throw new Error("body too large")
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return null
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}
