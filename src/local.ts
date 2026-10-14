// Local model runtime detection: probes Ollama and LM Studio for their
// OpenAI-compatible endpoints. Backs the "local" provider and the
// GET /api/local-models endpoint. No API key is needed for local runtimes.

export interface LocalRuntime {
  /** "ollama" | "lmstudio" | "custom" */
  vendor: string
  /** The OpenAI-compatible base URL that was probed successfully. */
  baseUrl: string
  /** Model ids reported by the runtime (GET <base>/models). */
  models: string[]
}

/** Standard locations, probed in parallel when nothing is configured. */
export const LOCAL_CANDIDATES: { vendor: string; baseUrl: string }[] = [
  { vendor: "ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { vendor: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" },
]

const PROBE_TIMEOUT_MS = 1500
const CACHE_MS = 30_000

// Keyed by what was probed ("auto" or the base URL) — different targets
// must not share a result.
const cache = new Map<string, { at: number; value: LocalRuntime | null }>()

/** Probe one OpenAI-compatible base URL and return its model ids. */
async function probe(baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "")
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return []
    const body: unknown = await res.json()
    const data = (body as { data?: unknown })?.data
    if (!Array.isArray(data)) return []
    return data
      .map((m) => (m as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  } catch {
    return [] // not running, not reachable, not OpenAI-compatible
  }
}

/**
 * Find a local model runtime. When `baseUrl` is given (from the config file
 * or ANVIL_LOCAL_BASE_URL) only that endpoint is probed; otherwise the
 * standard Ollama / LM Studio locations are checked in parallel. The result
 * is cached for 30 s (runtimes come and go, but we don't want to probe on
 * every request). Pass `force` to bypass the cache.
 */
export async function detectLocal(baseUrl?: string, force = false): Promise<LocalRuntime | null> {
  const trimmed = (baseUrl ?? "").trim()
  const targets: { vendor: string; baseUrl: string }[] = trimmed
    ? [{ vendor: "custom", baseUrl: trimmed.replace(/\/+$/, "") }]
    : LOCAL_CANDIDATES
  const cacheKey = trimmed ? trimmed.replace(/\/+$/, "") : "auto"
  const hit = cache.get(cacheKey)
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value

  let found: LocalRuntime | null = null
  const results = await Promise.all(
    targets.map(async (t) => ({ t, models: await probe(t.baseUrl) })),
  )
  for (const r of results) {
    if (r.models.length) {
      found = { vendor: r.t.vendor, baseUrl: r.t.baseUrl, models: r.models }
      break
    }
  }
  cache.set(cacheKey, { at: Date.now(), value: found })
  return found
}

/** Human-readable list of what was tried (for error messages). */
export function localCandidatesForError(): string {
  return LOCAL_CANDIDATES.map((c) => `${c.vendor} at ${c.baseUrl}`).join(", ")
}
