// Timeout guards for provider calls: neither a stuck connection nor a
// stalled (but open) stream may hang a session forever. A hung model call
// would otherwise pin the session "busy" with no error and no answer —
// the exact "nothing happens" failure mode reported from the web UI.

/** Give up establishing the connection after this long. */
export const CONNECT_TIMEOUT_MS = 30_000
/** Local runtimes (Ollama / LM Studio): the first request to a model that
 *  is not loaded yet blocks until the weights are read from disk — 7 GB
 *  models can take minutes, so allow a long connect phase for those. */
export const LOCAL_CONNECT_TIMEOUT_MS = 300_000
/** Grace period for the first chunk (long prefills under GPU load). */
export const FIRST_CHUNK_TIMEOUT_MS = 180_000
/** Grace period between subsequent chunks once streaming has started. */
export const IDLE_TIMEOUT_MS = 60_000

/** Reject if the promise has not settled within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} (no data for ${Math.round(ms / 1000)}s)`)),
      ms,
    )
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export interface ConnectSignal {
  /** Combined signal: caller's abort (if any) plus the connect timeout. */
  signal: AbortSignal | undefined
  /** Clear the timeout once the response headers have arrived. */
  stop: () => void
  /** True when the timeout — not the caller — aborted the request. */
  timedOut: () => boolean
}

/** Build a fetch() signal that aborts after `ms`. Use only around the
 *  request that establishes the connection, then call stop() as soon as
 *  headers arrive — the body may stream for minutes. */
export function connectSignal(signal: AbortSignal | undefined, ms: number): ConnectSignal {
  const ctl = new AbortController()
  let timedOut = false
  const t = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, ms)
  return {
    signal: signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal,
    stop: () => clearTimeout(t),
    timedOut: () => timedOut,
  }
}
