import { readFile, writeFile } from "node:fs/promises"
import type { Tool, ToolInput } from "../types.ts"

export const editTool: Tool = {
  name: "Edit",
  description:
    "Replace an exact text fragment in a file. old_string must match the file content exactly " +
    "(including whitespace). It must occur exactly once unless replace_all is true. " +
    "Add surrounding context to old_string to make it unique.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file." },
      old_string: { type: "string", description: "Exact text to find." },
      new_string: { type: "string", description: "Replacement text (must differ from old_string)." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  readOnly: false,
  async execute(input: ToolInput) {
    const path = String(input.file_path ?? "")
    const oldString = String(input.old_string ?? "")
    const newString = String(input.new_string ?? "")
    const replaceAll = Boolean(input.replace_all)
    if (!path) return { ok: false, output: "file_path is required." }
    if (!oldString) return { ok: false, output: "old_string is required." }
    if (oldString === newString) return { ok: false, output: "old_string and new_string must differ." }

    const raw = await readFile(path, "utf8").catch(() => null)
    if (raw === null) return { ok: false, output: `File not found: ${path}` }

    const count = raw.split(oldString).length - 1
    if (count === 0) {
      return {
        ok: false,
        output: "old_string was not found in the file. Read the file again and copy the exact text, including whitespace and indentation.",
      }
    }
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        output: `old_string occurs ${count} times. Include more surrounding context to make it unique, or set replace_all to true.`,
      }
    }

    const next = replaceAll ? raw.split(oldString).join(newString) : raw.replace(oldString, newString)
    await writeFile(path, next, "utf8")
    return { ok: true, output: `Edited ${path} (${count} occurrence${count === 1 ? "" : "s"} replaced).` }
  },
}
