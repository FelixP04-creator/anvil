// HTTP server: REST + SSE API over agent sessions, plus the web UI.
// Zero dependencies — plain node:http.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"

import { runAgent } from "./agent.ts"
import { lineDiff, type DiffLine } from "./diff.ts"
import {
  deleteSessionFile,
  listSessions,
  loadSession,
  migrateLegacySessions,
  saveSession,
  type SessionMeta,
} from "./store.ts"
import { PermissionEngine, type AskAnswer, type AskFn, type PermissionMode } from "./permissions.ts"
import { buildSubagentPrompt, buildSystemPrompt, detectEnv } from "./prompt.ts"
import { loadMemory } from "./memory.ts"
import { createMainTools, createSubagentTools } from "./tools/index.ts"
import { detectLocal, localCandidatesForError } from "./local.ts"
import { embeddedWeb } from "./web-assets.ts"
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
import type {
  ContentBlock,
  Message,
  Provider,
  ThinkingEffort,
  Tool,
  ToolContext,
  ToolInput,
  ToolResult,
} from "./types.ts"

/** Version: from the SEA bundle's injected global (exe), then package.json
 *  (single source of truth — works from src/ and dist/). */
export function version(): string {
  const g = globalThis as { __ANVIL_VERSION__?: string }
  if (typeof g.__ANVIL_VERSION__ === "string" && g.__ANVIL_VERSION__) return g.__ANVIL_VERSION__
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = readFileSync(join(here, "..", "package.json"), "utf8")
    const v = (JSON.parse(raw) as { version?: string }).version
    if (typeof v === "string" && v) return v
  } catch {
    // fall through
  }
  return "0.0.0"
}
export const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"]
export const THINKING: ThinkingEffort[] = THINKING_LEVELS

export interface ServerConfig {
  /**
   * May be undefined when no provider could be resolved at startup (no keys,
   * no local runtime). The server still runs — the web UI can configure one
   * later (PUT /api/config) and session creation re-resolves on demand.
   */
  provider?: Provider
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
  localBaseUrl: string | null
  configPath: string
}

export type ServerEvent = { type: string } & Record<string, unknown>

export type TranscriptEntry =
  | { role: "user"; text: string; msgIndex?: number; images?: { mediaType: string; data: string }[] }
  | { role: "assistant"; text: string; msgIndex?: number }
  | { role: "thinking"; text: string; msgIndex?: number }
  | { role: "tool"; name: string; args: ToolInput; ok: boolean; output: string; pending?: boolean; msgIndex?: number }

/** A file the agent changed this turn (for the live diff view + change panel). */
export interface FileChange {
  path: string
  kind: "write" | "edit"
  additions: number
  deletions: number
  diff: DiffLine[]
  /** true when the change happened inside a subagent (Task tool). */
  subagent?: boolean
}

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
  updatedAt = Date.now()
  usage = { input: 0, output: 0 }
  /** Set by the server so the session can persist itself to disk. */
  persist: (() => void) | null = null
  /** Where this session was forked from (if it was). */
  forkedFrom: { id: string; at: number } | null = null
  /** File changes of the current (or last finished) turn. */
  changes: FileChange[] = []

  private listeners = new Set<(e: ServerEvent) => void>()
  private pendingPermissions = new Map<
    string,
    { resolve: (a: AskAnswer) => void; toolName: string; detail: string; input: ToolInput }
  >()
  private permissionCounter = 0
  private tools: Tool[]
  provider: Provider
  private system: string
  private maxTurns: number
  private abortController: AbortController | null = null
  private lastTodosSig = ""
  /** Tool results of the current turn that executed but are not in the
   *  history yet (the turn is suspended between tool calls). */
  private completedTools: { ok: boolean; output: string }[] = []

  constructor(id: string, config: ServerConfig, mode: PermissionMode, overrides?: { model?: string; thinking?: ThinkingEffort; kind?: ProviderKind; provider?: Provider }) {
    this.id = id
    this.cwd = config.cwd
    // kind/provider may come from a different (persisted or parent) session
    // context than the global config — e.g. an old local session after the
    // user switched the provider back to the gateway.
    this.kind = overrides?.kind ?? config.kind
    this.model = overrides?.model || config.model
    this.thinking = overrides?.thinking ?? config.thinking
    this.provider = overrides?.provider ?? config.provider
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
    const subagentTools = this.wrapFileDiff(createSubagentTools(), true)
    return this.wrapFileDiff(
      createMainTools(this.ctx, {
        provider: this.provider,
        model: this.model,
        subagentSystem: buildSubagentPrompt(env),
        subagentTools,
        check: (t, i) => this.engine.check(t, i),
        maxTurns: 30,
      }),
      false,
    )
  }

  /**
   * Snapshot the file content before and after each Write/Edit and
   * broadcast a `file_change` event, so the web UI can render a live diff.
   * Paths resolve against process.cwd(), exactly like the tools do.
   */
  private wrapFileDiff(tools: Tool[], subagent: boolean): Tool[] {
    return tools.map((t) => {
      if (t.name !== "Write" && t.name !== "Edit") return t
      return {
        ...t,
        execute: async (input: ToolInput, ctx: ToolContext): Promise<ToolResult> => {
          const raw = String(input.file_path ?? "")
          if (!raw) return t.execute(input, ctx)
          const abs = isAbsolute(raw) ? raw : join(process.cwd(), raw)
          let before: string | null = null
          try {
            before = await readFile(abs, "utf8")
          } catch {
            before = null // new file
          }
          const res = await t.execute(input, ctx)
          if (!res.ok) return res
          let after: string | null = null
          try {
            after = await readFile(abs, "utf8")
          } catch {
            after = null
          }
          if (after === null) return res
          const d = lineDiff(before ?? "", after)
          const change: FileChange = {
            path: raw,
            kind: t.name === "Edit" ? "edit" : "write",
            additions: d.additions,
            deletions: d.deletions,
            diff: d.lines.slice(0, 300),
            subagent,
          }
          this.changes.push(change)
          if (this.changes.length > 20) this.changes.splice(0, this.changes.length - 20)
          this.broadcast({ type: "file_change", ...change })
          return res
        },
      }
    })
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  broadcast(e: ServerEvent): void {
    if (process.env.ANVIL_SSE_DEBUG) {
      console.error(`[sse:${this.id.slice(0, 8)}] broadcast ${e.type} → ${this.listeners.size} listener(s)`)
    }
    for (const fn of this.listeners) {
      try {
        fn(e)
      } catch (err) {
        // A failing subscriber must not kill the running turn.
        if (process.env.ANVIL_SSE_DEBUG) {
          console.error(`[sse:${this.id.slice(0, 8)}] subscriber error on ${e.type}: ${String(err).slice(0, 160)}`)
        }
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
    this.persist?.()
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
    this.persist?.()
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
      updatedAt: this.updatedAt,
      msgCount: this.history.length,
      forkedFrom: this.forkedFrom,
      turns: this.history.filter(
        (m) => m.role === "user" && m.content.some((b) => b.type === "text"),
      ).length,
      // File changes of the current/last turn (last 8, diffs capped) so a
      // (re)connecting client can re-render the change panel.
      changes: this.changes.slice(-8),
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
    for (let i = 0; i < this.history.length; i++) {
      const m = this.history[i]
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
              out.push({ role: "thinking", text: thought, msgIndex: i })
              thought = ""
            }
            if (pre) {
              out.push({ role: "assistant", text: pre, msgIndex: i })
              pre = ""
            }
            toolCount++
            out.push({ role: "tool", name: b.name, args: b.input ?? {}, ok: false, output: "", msgIndex: i })
          }
        }
        if (thought) out.push({ role: "thinking", text: thought, msgIndex: i })
        if (pre) out.push({ role: "assistant", text: pre, msgIndex: i })
        if (post) out.push({ role: "assistant", text: post, msgIndex: i })
      } else {
        let text = ""
        const images: { mediaType: string; data: string }[] = []
        for (const b of m.content) {
          if (b.type === "text") text += (text ? "\n\n" : "") + b.text
          else if (b.type === "image") images.push({ mediaType: b.mediaType, data: b.data })
          else if (b.type === "tool_result") {
            for (let k = out.length - 1; k >= 0; k--) {
              const e = out[k]
              if (e.role === "tool" && !filled.has(k)) {
                e.ok = !b.is_error
                e.output = b.content
                filled.add(k)
                break
              }
            }
          }
        }
        if (text || images.length) {
          out.push({
            role: "user",
            text,
            msgIndex: i,
            ...(images.length ? { images } : {}),
          })
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

  async send(text: string, images: { mediaType: string; data: string }[] = []): Promise<void> {
    if (this.busy) throw new Error("session is busy with another turn")
    this.busy = true
    this.changes = []
    const content: ContentBlock[] = [{ type: "text", text }]
    for (const img of images.slice(0, 8)) {
      content.push({ type: "image", mediaType: img.mediaType, data: img.data })
    }
    this.history.push({ role: "user", content })
    const ac = new AbortController()
    this.abortController = ac
    const turnUsage = { input: 0, output: 0 }
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
            if (e.type === "assistant_text") {
              // The assistant message of this response is the last one in
              // the history — the web UI uses the index as a fork point.
              this.broadcast({ ...e, msgIndex: this.history.length - 1 })
              return
            }
            this.broadcast({ ...e })
          },
        },
        this.history,
      )
      this.usage.input += result.usage.input
      this.usage.output += result.usage.output
      turnUsage.input += result.usage.input
      turnUsage.output += result.usage.output
    } finally {
      this.busy = false
      this.abortController = null
      this.completedTools = []
      this.updatedAt = Date.now()
      this.broadcast({
        type: "turn_end",
        usage: turnUsage,
        changes: this.changes,
        msgCount: this.history.length,
      })
      this.persist?.()
    }
  }
}

export class AnvilServer {
  sessions = new Map<string, Session>()
  private server: Server | null = null
  private webRoot: string
  private config: ServerConfig
  private settings: ResolvedSettings | null
  private diskCache: { at: number; items: SessionMeta[] } | null = null

  constructor(config: ServerConfig, settings?: ResolvedSettings) {
    this.config = config
    // When no settings are passed (mock/demo setup) they are resolved
    // lazily in listen() — that can be async (local runtime detection).
    this.settings = settings ?? null
    let here = process.cwd()
    try {
      here = dirname(fileURLToPath(import.meta.url))
    } catch {
      // embedded bundle without a resolvable module URL
    }
    this.webRoot = normalize(join(here, "..", "web"))
  }

  /** Wire the on-disk store to a session (save after create/turn/mode/fork). */
  private attachPersistence(s: Session): void {
    s.persist = () => {
      s.updatedAt = Date.now()
      void saveSession({
        id: s.id,
        title: s.title,
        kind: s.kind,
        model: s.model,
        thinking: s.thinking,
        mode: s.engine.mode,
        cwd: s.cwd,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        usage: { ...s.usage },
        forkedFrom: s.forkedFrom,
        history: s.history,
        todos: s.ctx.todos,
      }).catch(() => {})
    }
  }

  /** Persisted sessions from disk (2s cache — the UI polls every 4s). */
  private async cachedDiskSessions(): Promise<SessionMeta[]> {
    const now = Date.now()
    if (this.diskCache && now - this.diskCache.at < 2000) return this.diskCache.items
    const items = await listSessions().catch(() => [])
    this.diskCache = { at: now, items }
    return items
  }

  /** Bring a persisted session back into memory (server restart, other tab). */
  private async adoptStored(id: string): Promise<Session | null> {
    const stored = await loadSession(id).catch(() => null)
    if (!stored) return null
    // A session remembers the provider kind it was created with — its model
    // names belong to that provider. When the global config has moved on
    // (provider switched, server restarted), rebuild the matching provider
    // instead of silently re-homing the session onto the current one.
    let kind: ProviderKind = this.config.kind
    let provider = this.config.provider
    if (stored.kind !== this.config.kind) {
      try {
        const s = await resolveSettings({
          provider: stored.kind,
          model: stored.model,
          thinking: stored.thinking,
        })
        kind = s.kind
        provider = s.provider
      } catch {
        // The old provider is no longer usable (key removed, local runtime
        // stopped) — fall back to the current config.
      }
    }
    const session = new Session(stored.id, this.config, stored.mode, {
      model: stored.model,
      thinking: stored.thinking,
      kind,
      provider,
    })
    session.history = stored.history
    session.ctx = { cwd: stored.cwd, todos: stored.todos }
    session.usage = stored.usage
    session.createdAt = stored.createdAt
    session.updatedAt = stored.updatedAt
    session.forkedFrom = stored.forkedFrom
    this.sessions.set(stored.id, session)
    this.attachPersistence(session)
    return session
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
      localBaseUrl: process.env.ANVIL_LOCAL_BASE_URL || file.localBaseUrl || null,
      configPath: configPath(),
    }
  }

  /**
   * Start listening; returns the actual port (pass 0 for an ephemeral one).
   * `host` defaults to loopback — pass 0.0.0.0 (e.g. `anvil server
   * --host 0.0.0.0`) to make the UI reachable from other devices on the
   * network (phones, tablets). The API has no authentication; only bind
   * to 0.0.0.0 on networks you trust.
   */
  async listen(port = 8787, host = "127.0.0.1"): Promise<number> {
    await migrateLegacySessions()
    if (!this.settings) {
      try {
        this.settings = await resolveSettings()
      } catch {
        // No keys / no local runtime resolvable (mock/demo setup) —
        // settings still work via the config file once one exists.
      }
    }
    const http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) {
          const msg = String(err)
          json(res, msg.includes("body too large") ? 413 : 500, { error: msg })
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject)
      http.listen(port, host, () => resolve())
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

    // CORS: the web UI is normally same-origin, but the mobile apps load
    // the server UI cross-origin (from the app's own origin), and other
    // tools may probe it. The API is unauthenticated — see listen().
    res.setHeader("access-control-allow-origin", "*")
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
    res.setHeader("access-control-allow-headers", "content-type, authorization")
    if (method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (path.startsWith("/api/")) {
      if (method === "GET" && path === "/api/health") {
        return json(res, 200, { ok: true, version: version() })
      }

      if (method === "GET" && path === "/api/local-models") {
        // Probe a local runtime (Ollama / LM Studio / configured base) so
        // the UI can offer its models. 200 + ok:false when nothing found.
        const rt = await detectLocal(
          process.env.ANVIL_LOCAL_BASE_URL || loadConfig().localBaseUrl || undefined,
          true,
        )
        if (!rt) {
          return json(res, 200, {
            ok: false,
            error: `no local runtime found (tried: ${localCandidatesForError()})`,
          })
        }
        return json(res, 200, { ok: true, vendor: rt.vendor, baseUrl: rt.baseUrl, models: rt.models })
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
          if (
            provider !== "" &&
            provider !== "anthropic" &&
            provider !== "openai" &&
            provider !== "hsnr" &&
            provider !== "local"
          ) {
            return json(res, 400, { error: "provider must be one of: anthropic | openai | hsnr | local (or empty to auto-detect)" })
          }
          patch.provider = (provider || undefined) as ProviderKind
        }
        const model = str("model")
        if (model !== undefined) patch.model = model
        const thinking = str("thinking")
        if (thinking !== undefined) {
          if (thinking !== "" && !THINKING_LEVELS.includes(thinking as ThinkingEffort)) {
            return json(res, 400, { error: `thinking must be one of: ${THINKING_LEVELS.join(" | ")}` })
          }
          patch.thinking = (thinking || undefined) as ThinkingEffort
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
        const localBase = str("localBaseUrl")
        if (localBase !== undefined) patch.localBaseUrl = localBase

        saveConfig(patch)
        // Re-resolve the provider. When nothing resolvable exists
        // (e.g. a mock/demo server without keys) the settings are still
        // saved — model and thinking become active as soon as a key or a
        // local runtime exists.
        let note = "settings apply to new sessions"
        try {
          const s = await resolveSettings()
          this.settings = s
          this.config = {
            provider: s.provider,
            kind: s.kind,
            model: s.model,
            thinking: s.thinking,
            cwd: this.config.cwd,
            maxTurns: this.config.maxTurns,
          }
        } catch (err) {
          this.settings = null
          const file = loadConfig()
          this.config = {
            ...this.config,
            model: file.model || this.config.model,
            thinking: file.thinking ?? this.config.thinking,
          }
          note = `saved — not active yet: ${String(err).split("\n")[0].slice(0, 200)}`
        }
        return json(res, 200, { ok: true, note, config: this.configView() })
      }

      if (method === "POST" && path === "/api/sessions") {
        // A provider may have become available since startup (e.g. Ollama
        // was just started) — try to (re)resolve before giving up.
        if (!this.config.provider) {
          try {
            const s = await resolveSettings()
            this.settings = s
            this.config = { ...this.config, provider: s.provider, kind: s.kind, model: s.model, thinking: s.thinking }
          } catch {
            return json(res, 503, {
              error:
                "no provider configured yet — set an API key in the web UI settings or start a local runtime (Ollama / LM Studio) and try again",
            })
          }
        }
        const body = (await readJson(req)) ?? {}
        const id = randomUUID()
        const requested = body.mode as PermissionMode | undefined
        const mode: PermissionMode = requested && MODES.includes(requested) ? requested : "default"
        const thinkingReq = body.thinking as ThinkingEffort | undefined
        const thinking = thinkingReq && THINKING_LEVELS.includes(thinkingReq) ? thinkingReq : undefined
        const modelReq = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined
        const session = new Session(id, this.config, mode, { model: modelReq, thinking })
        this.sessions.set(id, session)
        this.attachPersistence(session)
        session.persist?.()
        return json(res, 201, {
          id,
          cwd: this.config.cwd,
          model: session.model,
          thinking: session.thinking,
          mode,
        })
      }

      if (method === "GET" && path === "/api/sessions") {
        const disk = await this.cachedDiskSessions()
        interface Row {
          id: string
          title: string
          model: string
          mode: string
          cwd: string
          busy: boolean
          turns: number
          createdAt: number
          updatedAt: number
          [k: string]: unknown
        }
        const byId = new Map<string, Row>()
        for (const m of disk) {
          byId.set(m.id, {
            id: m.id,
            title: m.title,
            model: m.model,
            mode: m.mode,
            cwd: m.cwd,
            busy: false,
            turns: m.turns,
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
            thinking: m.thinking,
            usage: m.usage,
            forkedFrom: m.forkedFrom,
            needsPermission: false,
          })
        }
        for (const s of this.sessions.values()) {
          const st = s.state()
          byId.set(s.id, {
            id: s.id,
            title: st.title,
            model: s.model,
            mode: st.mode,
            cwd: s.cwd,
            busy: st.busy,
            turns: st.turns,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            thinking: s.thinking,
            usage: s.usage,
            forkedFrom: s.forkedFrom,
            needsPermission: st.pendingPermission !== null,
          })
        }
        const sessions = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
        return json(res, 200, { sessions })
      }

      const m = path.match(
        /^\/api\/sessions\/([^/]+)(?:\/(messages|events|permissions|mode|transcript|abort|fork))?$/,
      )
      if (m) {
        let session = this.sessions.get(m[1])
        if (!session) session = await this.adoptStored(m[1])
        if (!session) return json(res, 404, { error: "unknown session" })
        const sub = m[2]

        if (method === "GET" && !sub) return json(res, 200, session.state())

        if (method === "DELETE" && !sub) {
          session.abort()
          this.sessions.delete(m[1])
          // Awaiting matters: a concurrent GET must not be able to re-adopt
          // the session from a file that is still on disk.
          await deleteSessionFile(m[1])
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
          const body = await readJson(req, 15_000_000)
          const text = typeof body?.text === "string" ? body.text : ""
          const images: { mediaType: string; data: string }[] = []
          if (Array.isArray(body?.images)) {
            for (const im of body.images as unknown[]) {
              const o = im as { mediaType?: unknown; data?: unknown } | null
              if (
                o &&
                typeof o.mediaType === "string" &&
                o.mediaType.startsWith("image/") &&
                typeof o.data === "string"
              ) {
                images.push({ mediaType: o.mediaType, data: o.data })
              }
            }
          }
          if (!text && images.length === 0) return json(res, 400, { error: "text and/or images are required" })
          if (session.busy) return json(res, 409, { error: "session is busy with another turn" })
          session.send(text, images).catch((err) => {
            session.broadcast({ type: "error", text: String(err) })
          })
          return json(res, 202, { started: true })
        }

        if (method === "POST" && sub === "fork") {
          if (session.busy) return json(res, 409, { error: "wait for the turn to finish before forking" })
          if (session.history.length === 0) return json(res, 400, { error: "nothing to fork yet" })
          const body = (await readJson(req)) ?? {}
          const reqIdx =
            typeof body.msgIndex === "number" && Number.isFinite(body.msgIndex)
              ? Math.floor(body.msgIndex as number)
              : session.history.length - 1
          // A fork point must end on a complete message: never inside a
          // tool_use/tool_result pair (the next API call would be invalid).
          const validEnd = (j: number): boolean => {
            const mm = session.history[j]
            if (!mm) return false
            if (mm.role === "user") return true
            return !mm.content.some((b) => b.type === "tool_use")
          }
          let cut = Math.max(0, Math.min(reqIdx, session.history.length - 1))
          while (cut > 0 && !validEnd(cut)) cut--
          if (!validEnd(cut)) return json(res, 400, { error: "no valid fork point at this position" })
          const fork = new Session(randomUUID(), this.config, session.engine.mode, {
            model: session.model,
            thinking: session.thinking,
            kind: session.kind,
            provider: session.provider,
          })
          fork.history = structuredClone(session.history.slice(0, cut + 1))
          fork.ctx.todos = structuredClone(session.ctx.todos)
          fork.usage = { ...session.usage }
          fork.forkedFrom = { id: session.id, at: cut }
          this.sessions.set(fork.id, fork)
          this.attachPersistence(fork)
          fork.persist?.()
          return json(res, 201, { id: fork.id, title: fork.title, forkedFrom: fork.forkedFrom })
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
    const dbg = (m: string) => {
      if (process.env.ANVIL_SSE_DEBUG) console.error(`[sse:${session.id.slice(0, 8)}] ${m}`)
    }
    const unsubscribe = session.subscribe((e) => {
      if (!res.writableEnded) {
        const ok = res.write(sse(e))
        dbg(`write ${e.type} ok=${ok} ended=${res.writableEnded} destroyed=${res.destroyed}`)
      } else {
        dbg(`DROP ${e.type} (writableEnded)`)
      }
    })
    // Comment-line heartbeat: keeps idle-connection killers (routers, proxies,
    // NATs) from resetting a long-lived stream and surfaces dead sockets.
    // EventSource clients ignore ":" comment lines per spec.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": hb\n\n")
    }, 15000)
    req.on("close", () => {
      clearInterval(heartbeat)
      dbg("req close → unsubscribe")
      unsubscribe()
    })
    res.on("error", (err) => dbg(`res error: ${String(err).slice(0, 160)}`))
    res.on("close", () => {
      clearInterval(heartbeat)
      dbg("res close")
    })
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    })
    res.write("retry: 2000\n\n")
    // State snapshot so (re)connecting clients can re-sync.
    res.write(sse({ type: "session", ...session.state() }))
    dbg("subscribed, snapshot sent")
  }

  private serveStatic(res: ServerResponse, urlPath: string): void {
    const name = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "")
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".json": "application/json; charset=utf-8",
    }
    const ext = name.slice(name.lastIndexOf("."))
    // Single-file exe: the web/ directory does not exist next to the
    // binary — serve the assets embedded at build time instead.
    const embedded = embeddedWeb(name)
    if (embedded !== null) {
      res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" })
      res.end(embedded)
      return
    }
    const full = normalize(join(this.webRoot, name))
    if (!full.startsWith(this.webRoot) || !existsSync(full)) {
      json(res, 404, { error: "not found" })
      return
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

async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new Error("body too large")
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return null
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}
