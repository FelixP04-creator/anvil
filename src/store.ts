// Session persistence: one JSON file per session in ~/.anvil/anvil-sessions/
// (next to the config file; $ANVIL_CONFIG redirects the whole tree, which
// keeps the test suite hermetic). Used by the web server (so sessions
// survive restarts) and the CLI (`anvil -c`, `anvil -r <id>`, `anvil sessions`).

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { configPath } from "./config.ts"
import type { PermissionMode } from "./permissions.ts"
import type { ProviderKind } from "./providers/index.ts"
import type { Message, ThinkingEffort, Todo } from "./types.ts"

export interface StoredSession {
  id: string
  title: string
  kind: ProviderKind
  model: string
  thinking: ThinkingEffort
  mode: PermissionMode
  cwd: string
  createdAt: number
  updatedAt: number
  usage: { input: number; output: number }
  forkedFrom: { id: string; at: number } | null
  history: Message[]
  todos: Todo[]
}

/** Lightweight session row for listings (no history payload). */
export interface SessionMeta {
  id: string
  title: string
  kind: ProviderKind
  model: string
  thinking: ThinkingEffort
  mode: PermissionMode
  cwd: string
  createdAt: number
  updatedAt: number
  usage: { input: number; output: number }
  turns: number
  forkedFrom: { id: string; at: number } | null
}

export function sessionsDir(): string {
  return join(dirname(configPath()), "anvil-sessions")
}

function fileFor(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid session id: ${id}`)
  return join(sessionsDir(), `${id}.json`)
}

export async function saveSession(s: StoredSession): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFile(fileFor(s.id), JSON.stringify(s), "utf8")
}

/** Load a session by exact id, or by unique prefix (CLI convenience). */
export async function loadSession(id: string): Promise<StoredSession | null> {
  if (/^[A-Za-z0-9._-]+$/.test(id)) {
    try {
      const data = await readFile(fileFor(id), "utf8")
      const s = JSON.parse(data) as StoredSession
      return s && Array.isArray(s.history) ? s : null
    } catch {
      // fall through to prefix matching
    }
  }
  const hits = (await listSessions()).filter((m) => m.id.startsWith(id))
  if (hits.length !== 1) return null
  const exact = await loadSession(hits[0].id)
  return exact
}

/** All persisted sessions, most recently updated first. */
export async function listSessions(): Promise<SessionMeta[]> {
  let names: string[] = []
  try {
    names = await readdir(sessionsDir())
  } catch {
    return []
  }
  const out: SessionMeta[] = []
  for (const n of names) {
    if (!n.endsWith(".json")) continue
    try {
      const s = JSON.parse(await readFile(join(sessionsDir(), n), "utf8")) as StoredSession
      if (!s || typeof s.id !== "string" || !Array.isArray(s.history)) continue
      out.push(metaOf(s))
    } catch {
      // skip a corrupt file — it must not break the listing
    }
  }
  return out.sort((x, y) => y.updatedAt - x.updatedAt)
}

export async function deleteSessionFile(id: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return
  try {
    await rm(fileFor(id))
  } catch {
    // already gone
  }
}

function metaOf(s: StoredSession): SessionMeta {
  const turns = s.history.filter(
    (m) => m.role === "user" && m.content.some((b) => b.type === "text"),
  ).length
  return {
    id: s.id,
    title: s.title,
    kind: s.kind,
    model: s.model,
    thinking: s.thinking,
    mode: s.mode,
    cwd: s.cwd,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    usage: s.usage,
    turns,
    forkedFrom: s.forkedFrom ?? null,
  }
}
