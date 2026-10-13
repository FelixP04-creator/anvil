import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { Tool, ToolInput } from "../types.ts"

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".anvil"])
const MAX_RESULTS = 2000

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Convert a glob pattern (/, **, *, ?, {a,b}) to an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, "/")
  let re = ""
  let i = 0
  while (i < p.length) {
    const c = p[i]
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          re += "(?:[^/]+/)*"
          i += 3
        } else {
          re += ".*"
          i += 2
        }
      } else {
        re += "[^/]*"
        i += 1
      }
    } else if (c === "?") {
      re += "[^/]"
      i += 1
    } else if (c === "{") {
      const end = p.indexOf("}", i)
      if (end !== -1) {
        const alts = p
          .slice(i + 1, end)
          .split(",")
          .map(escapeRe)
        re += `(?:${alts.join("|")})`
        i = end + 1
      } else {
        re += "\\{"
        i += 1
      }
    } else {
      re += escapeRe(c)
      i += 1
    }
  }
  return new RegExp(`^${re}$`)
}

async function walk(dir: string, results: string[], visited: number): Promise<void> {
  if (results.length >= MAX_RESULTS || visited > 20_000) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
      await walk(full, results, visited + 1)
    } else if (entry.isFile()) {
      results.push(full)
    }
  }
}

export const globTool: Tool = {
  name: "Glob",
  description:
    "Find files by glob pattern (supports *, **, ?, {a,b}). Returns matching paths relative to the search root, sorted.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'." },
      path: { type: "string", description: "Directory to search in (default: working directory)." },
    },
    required: ["pattern"],
  },
  readOnly: true,
  async execute(input: ToolInput, ctx) {
    const pattern = String(input.pattern ?? "")
    if (!pattern) return { ok: false, output: "pattern is required." }
    const root = String(input.path ?? "") || ctx.cwd
    let re: RegExp
    try {
      re = globToRegExp(pattern)
    } catch {
      return { ok: false, output: "Invalid glob pattern." }
    }
    // Walk the root's parent-relative form: match the pattern against paths
    // relative to the root, but also allow patterns with directory prefixes
    // by walking the root itself.
    const matches: string[] = []
    await walk(root, matches, 0)
    const rel = matches
      .map((m) => m.slice(root.length + 1).replace(/\\/g, "/"))
      .filter((m) => re.test(m))
      .sort()
      .slice(0, 1000)
    return { ok: true, output: rel.length ? rel.join("\n") : "No files matched." }
  },
}
