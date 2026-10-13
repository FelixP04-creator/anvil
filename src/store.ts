// Session persistence: one JSON file per session in ~/.anvil/anvil-sessions/
// (next to the config file; $ANVIL_CONFIG redirects the whole tree, which
// keeps the test suite hermetic). Used by the web server (so sessions
// survive restarts) and the CLI (`anvil -c`, `anvil -r <id>`, `anvil sessions`).

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
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
  // A hidden .anvil/ folder next to the config file — with the default
  // config (~/.anvil.json) that is ~/.anvil/anvil-sessions/.
  return join(dirname(configPath()), ".anvil", "anvil-sessions")
}

function fileFor(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid session id: ${id}`)
  return join(sessionsDir(), `${id}.json`)
}

/**
 * v0.6.0 briefly stored sessions in <config dir>/anvil-sessions (a visible
 * folder straight in the home dir). Move any stragglers into the new hidden
 * location once; a no-op when nothing old exists.
 */
let legacyMigrated = false
export async function migrateLegacySessions(): Promise<void> {
  if (legacyMigrated) return
  legacyMigrated = true
  const legacy = join(dirname(configPath()), "anvil-sessions")
  try {
    const entries = await readdir(legacy)
    if (entries.length === 0) {
      await rm(legacy, { recursive: true, force: true })
      return
    }
    const next = sessionsDir()
    await mkdir(next, { recursive: true })
    for (const name of entries) {
      if (!name.endsWith(".json")) continue
      await rename(join(legacy, name), join(next, name))
    }
    await rm(legacy, { recursive: true, force: true }).catch(() => {})
  } catch {
    // no legacy dir — nothing to migrate
  }
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
