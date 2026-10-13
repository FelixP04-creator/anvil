// Line diff for the live file-change view. Zero dependencies.
//
// Strategy: strip the common prefix/suffix line runs (O(n)), then align the
// changed middle with a bounded LCS (O(n·m) DP, only when the middle is
// small enough). The result is a list of context/add/delete lines with old
// and new line numbers, capped so a huge rewrite can't blow up the event
// stream or the session snapshot.

export interface DiffLine {
  t: "ctx" | "add" | "del"
  text: string
  /** Line number in the OLD file (ctx, del). */
  no: number | null
  /** Line number in the NEW file (ctx, add). */
  nn: number | null
  /** Set on a synthetic "… n lines" gap row (truncation marker). */
  gap?: number
}

export interface DiffResult {
  lines: DiffLine[]
  additions: number
  deletions: number
  truncated: boolean
}

/** LCS DP only runs below this many cells (≈ 316 × 316 lines). */
const MAX_LCS_CELLS = 100_000
/** Total diff lines kept in the result. */
const MAX_DIFF_LINES = 600

export function lineDiff(oldText: string, newText: string): DiffResult {
  const a = splitLines(oldText)
  const b = splitLines(newText)

  let p = 0
  const maxP = Math.min(a.length, b.length)
  while (p < maxP && a[p] === b[p]) p++
  let s = 0
  while (s < maxP - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++

  const full = buildLines(a, b, p, s)

  let additions = 0
  let deletions = 0
  for (const l of full) {
    if (l.t === "add") additions++
    else if (l.t === "del") deletions++
  }

  let lines = full
  let truncated = false
  if (full.length > MAX_DIFF_LINES) {
    truncated = true
    const head = 250
    const tail = 250
    const removed = full.length - head - tail
    lines = [
      ...full.slice(0, head),
      { t: "ctx", text: "", no: null, nn: null, gap: removed },
      ...full.slice(-tail),
    ]
  }

  return { lines, additions, deletions, truncated }
}

/** Full (uncapped) line list: common prefix, aligned middle, common suffix. */
function buildLines(a: string[], b: string[], p: number, s: number): DiffLine[] {
  const midA = a.slice(p, a.length - s)
  const midB = b.slice(p, b.length - s)
  const lines: DiffLine[] = []
  for (let i = 0; i < p; i++) lines.push({ t: "ctx", text: a[i], no: i + 1, nn: i + 1 })
  if (midA.length || midB.length) {
    if (midA.length * midB.length <= MAX_LCS_CELLS) {
      alignLcs(midA, midB, p, lines)
    } else {
      // Middle too big for LCS: show everything removed, then everything added.
      for (let i = 0; i < midA.length; i++) lines.push({ t: "del", text: midA[i], no: p + i + 1, nn: null })
      for (let i = 0; i < midB.length; i++) lines.push({ t: "add", text: midB[i], no: null, nn: p + i + 1 })
    }
  }
  for (let i = 0; i < s; i++) {
    lines.push({
      t: "ctx",
      text: a[a.length - s + i],
      no: a.length - s + i + 1,
      nn: p + midB.length + i + 1,
    })
  }
  return lines
}

/** LCS alignment of the changed middle; appends to `out`. */
function alignLcs(a: string[], b: string[], base: number, out: DiffLine[]): void {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Array<number>((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: "ctx", text: a[i], no: base + i + 1, nn: base + j + 1 })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ t: "del", text: a[i], no: base + i + 1, nn: null })
      i++
    } else {
      out.push({ t: "add", text: b[j], no: null, nn: base + j + 1 })
      j++
    }
  }
  while (i < n) {
    out.push({ t: "del", text: a[i], no: base + i + 1, nn: null })
    i++
  }
  while (j < m) {
    out.push({ t: "add", text: b[j], no: null, nn: base + j + 1 })
    j++
  }
}

function splitLines(s: string): string[] {
  if (!s) return []
  const out = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  if (out.length && out[out.length - 1] === "") out.pop()
  return out
}
