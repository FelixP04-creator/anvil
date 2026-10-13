import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Tool, ToolInput } from "../types.ts"

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".anvil"])
const MAX_FILE_BYTES = 1_000_000
const MAX_MATCHES = 300

export const grepTool: Tool = {
  name: "Grep",
  description:
    "Search file contents with a regular expression. Returns 'path:line: text' for each match. " +
    "Skips binary files, files over 1 MB, and common build directories.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "File or directory to search in (default: working directory)." },
      include: { type: "string", description: "Only search files whose name ends with this suffix or matches this glob-lite pattern, e.g. '.ts'." },
      case_sensitive: { type: "boolean", description: "Case-sensitive matching (default true)." },
    },
    required: ["pattern"],
  },
  readOnly: true,
  async execute(input: ToolInput, ctx) {
    const pattern = String(input.pattern ?? "")
    if (!pattern) return { ok: false, output: "pattern is required." }
    const include = input.include !== undefined ? String(input.include) : null
    const flags = input.case_sensitive === false ? "i" : ""
    let re: RegExp
    try {
      re = new RegExp(pattern, flags)
    } catch (err) {
      return { ok: false, output: `Invalid regex: ${String(err)}` }
    }

    const root = String(input.path ?? "") || ctx.cwd
    const matches: string[] = []

    const checkFile = async (file: string, displayPath: string) => {
      if (matches.length >= MAX_MATCHES) return
      const info = await stat(file).catch(() => null)
      if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) return
      if (include && !displayPath.endsWith(include)) return
      const raw = await readFile(file, "utf8").catch(() => null)
      if (raw === null || raw.includes("\u0000")) return
      const lines = raw.split(/\r?\n/)
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        if (re.test(lines[i])) {
          matches.push(`${displayPath}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
        }
      }
    }

    const walk = async (dir: string) => {
      if (matches.length >= MAX_MATCHES) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (matches.length >= MAX_MATCHES) return
        const full = join(dir, entry.name)
        const rel = full.slice(root.length + 1).replace(/\\/g, "/")
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
          await walk(full)
        } else if (entry.isFile()) {
          await checkFile(full, rel)
        }
      }
    }

    // If root is a single file, search just that file.
    const rootStat = await stat(root).catch(() => null)
    if (rootStat?.isFile()) {
      await checkFile(root, root)
    } else {
      await walk(root)
    }

    return {
      ok: true,
      output: matches.length ? matches.join("\n") : "No matches.",
    }
  },
}
