import { spawn } from "node:child_process"
import type { Tool, ToolInput } from "../types.ts"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 30_000

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const head = text.slice(0, MAX_OUTPUT_CHARS - 200)
  return `${head}\n… [output truncated, ${text.length} chars total] …`
}

export const bashTool: Tool = {
  name: "Bash",
  description:
    "Run a shell command in the working directory and return its output. " +
    "The shell is fresh for every call (no persistent state). Use for builds, tests, git, and package commands. " +
    "Prefer the dedicated file tools for reading, writing, and searching files.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).` },
    },
    required: ["command"],
  },
  readOnly: false,
  async execute(input: ToolInput, ctx) {
    const command = String(input.command ?? "")
    if (!command) return { ok: false, output: "command is required." }
    const timeout = Math.min(Number(input.timeout_ms ?? DEFAULT_TIMEOUT_MS), 600_000)

    const isWin = process.platform === "win32"
    const child = spawn(
      isWin ? "powershell.exe" : "/bin/sh",
      isWin ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command],
      { cwd: ctx.cwd },
    )

    let stdout = ""
    let stderr = ""
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      child.kill("SIGKILL")
    }, timeout)

    const result = await new Promise<{ code: number | null }>((resolve) => {
      child.stdout.on("data", (d) => (stdout += d.toString()))
      child.stderr.on("data", (d) => (stderr += d.toString()))
      child.on("error", (err) => resolve({ code: null }))
      child.on("close", (code) => resolve({ code }))
    })
    clearTimeout(timer)

    if (result.code === null) return { ok: false, output: `Failed to start shell: ${command}` }
    const parts: string[] = []
    if (killed) parts.push(`[timed out after ${timeout} ms]`)
    if (stdout.trim()) parts.push(truncate(stdout))
    if (stderr.trim()) parts.push(`stderr:\n${truncate(stderr)}`)
    const output = parts.length ? parts.join("\n") : "(no output)"
    return { ok: result.code === 0, output: `exit code: ${result.code}\n${output}` }
  },
}
