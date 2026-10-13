import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Tool, ToolInput } from "../types.ts"

export const writeTool: Tool = {
  name: "Write",
  description:
    "Write content to a file, creating parent directories as needed. Overwrites the file if it exists. " +
    "Use for creating new files or replacing a file entirely.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file." },
      content: { type: "string", description: "Full new content of the file." },
    },
    required: ["file_path", "content"],
  },
  readOnly: false,
  async execute(input: ToolInput) {
    const path = String(input.file_path ?? "")
    const content = typeof input.content === "string" ? input.content : null
    if (!path) return { ok: false, output: "file_path is required." }
    if (content === null) return { ok: false, output: "content is required." }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, "utf8")
    return { ok: true, output: `Wrote ${content.length} characters to ${path}` }
  },
}
