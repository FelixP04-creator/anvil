import { readFile, stat } from "node:fs/promises"
import type { Tool, ToolInput } from "../types.ts"

const MAX_FILE_BYTES = 200 * 1024
const MAX_LINE_LENGTH = 2000

export const readTool: Tool = {
  name: "Read",
  description:
    "Read a text file from the filesystem. Returns lines numbered like '  12: content'. " +
    "For large files pass offset (1-based line) and limit (max lines).",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file (absolute or relative to cwd)." },
      offset: { type: "number", description: "1-based line number to start from." },
      limit: { type: "number", description: "Maximum number of lines to return." },
    },
    required: ["file_path"],
  },
  readOnly: true,
  async execute(input: ToolInput, ctx) {
    const path = String(input.file_path ?? "")
    if (!path) return { ok: false, output: "file_path is required." }
    const info = await stat(path).catch(() => null)
    if (!info) return { ok: false, output: `File not found: ${path}` }
    if (!info.isFile()) return { ok: false, output: `Not a file: ${path}` }
    if (info.size > MAX_FILE_BYTES) {
      const offset = Number(input.offset ?? 1)
      const limit = Number(input.limit ?? 0)
      if (!limit || limit <= 0) {
        return {
          ok: false,
          output: `File is large (${info.size} bytes). Read it in slices: pass offset (1-based line) and limit (lines).`,
        }
      }
    }
    const raw = await readFile(path, "utf8")
    const lines = raw.split(/\r?\n/)
    const offset = Math.max(1, Number(input.offset ?? 1))
    const limit = Math.max(0, Number(input.limit ?? 0)) || lines.length - offset + 1
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const out = slice
      .map((l, i) => `${String(offset + i).padStart(6)}: ${l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + "…" : l}`)
      .join("\n")
    return {
      ok: true,
      output: out || "(empty file)",
    }
  },
}

export { readTool as Read }
export type { ToolInput }
