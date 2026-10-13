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
import type { Message, Provider, ToolContext, Tool, ToolInput } from "./types.ts"

export const VERSION = "0.2.0"
export const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"]

export interface ServerConfig {
  provider: Provider
  model: string
  cwd: string
  maxTurns?: number
}

export type ServerEvent = { type: string } & Record<string, unknown>

export type TranscriptEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; name: string; args: ToolInput; ok: boolean; output: string }

/**
 * One web/CLI session: owns the conversation history, tool context and
 * permission engine. Permission prompts suspend the turn as a pending
 * promise and are answered through the API (or resolve immediately for
 * auto-allowed actions).
 */
export class Session {
  id: string
  cwd: string
  model: string
  ctx: ToolContext
  history: Message[]
  engine: PermissionEngine
  busy = false

  private listeners = new Set<(e: ServerEvent) => void>()
  private pendingPermissions = new Map<
    string,
    { resolve: (a: AskAnswer) => void; toolName: string; detail: string }
  >()
  private permissionCounter = 0
  private tools: Tool[]
  private provider: Provider
  private system: string
  private maxTurns: number

  constructor(id: string, config: ServerConfig, mode: PermissionMode) {
    this.id = id
    this.cwd = config.cwd
    this.model = config.model
    this.provider = config.provider
    this.maxTurns = config.maxTurns ?? 50
    this.ctx = { cwd: config.cwd, todos: [] }
    this.history = []

    const env = detectEnv(config.cwd)
    this.system = buildSystemPrompt(env, loadMemory(config.cwd))

    const ask: AskFn = (toolName, _input, detail) =>
      new Promise<AskAnswer>((resolve) => {
        const permId = `perm-${++this.permissionCounter}`
        this.pendingPermissions.set(permId, { resolve, toolName, detail })
        this.broadcast({ type: "permission_request", id: permId, toolName, detail })
      })
    this.engine = new PermissionEngine(mode, ask, true)

    this.tools = createMainTools(this.ctx, {
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
    return true
  }

  setMode(mode: PermissionMode): void {
    this.engine.mode = mode
    this.broadcast({ type: "mode_changed", mode })
  }

  state() {
    const pending = [...this.pendingPermissions.entries()]
    return {
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      mode: this.engine.mode,
      busy: this.busy,
      todos: this.ctx.todos,
      turns: this.history.filter(
        (m) => m.role === "user" && m.content.some((b) => b.type === "text"),
      ).length,
      // Included in the SSE "session" snapshot so (re)connecting clients can
      // re-render an unanswered permission prompt.
      pendingPermission: pending.length
        ? { id: pending[0][0], toolName: pending[0][1].toolName, detail: pending[0][1].detail }
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
        let text = ""
        for (const b of m.content) {
          if (b.type === "text") text += b.text
          else if (b.type === "tool_use") {
            out.push({ role: "tool", name: b.name, args: b.input ?? {}, ok: false, output: "" })
          }
        }
        if (text) out.push({ role: "assistant", text })
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
    return out
  }

  async send(text: string): Promise<void> {
    if (this.busy) throw new Error("session is busy with another turn")
    this.busy = true
    this.history.push({ role: "user", content: [{ type: "text", text }] })
    try {
      await runAgent(
        {
          provider: this.provider,
          model: this.model,
          system: this.system,
          tools: this.tools,
          permissions: this.engine,
          context: this.ctx,
          maxTurns: this.maxTurns,
          onEvent: (e) => this.broadcast({ ...e }),
        },
        this.history,
      )
    } finally {
      this.busy = false
      this.broadcast({ type: "turn_end" })
    }
  }
}

export class AnvilServer {
  sessions = new Map<string, Session>()
  private server: Server | null = null
  private webRoot: string
  private config: ServerConfig

  constructor(config: ServerConfig) {
    this.config = config
    const here = dirname(fileURLToPath(import.meta.url))
    this.webRoot = normalize(join(here, "..", "web"))
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

      if (method === "POST" && path === "/api/sessions") {
        const body = (await readJson(req)) ?? {}
        const id = randomUUID()
        const mode: PermissionMode = MODES.includes(body.mode) ? body.mode : "default"
        this.sessions.set(id, new Session(id, this.config, mode))
        return json(res, 201, { id, cwd: this.config.cwd, model: this.config.model, mode })
      }

      const m = path.match(
        /^\/api\/sessions\/([^/]+)(?:\/(messages|events|permissions|mode|transcript))?$/,
      )
      if (m) {
        const session = this.sessions.get(m[1])
        if (!session) return json(res, 404, { error: "unknown session" })
        const sub = m[2]

        if (method === "GET" && !sub) return json(res, 200, session.state())

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
          const mode = body?.mode
          if (!MODES.includes(mode)) return json(res, 400, { error: `mode must be one of: ${MODES.join(" | ")}` })
          session.setMode(mode)
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
