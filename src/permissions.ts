// Permission engine: decides which tool calls may run without asking.

import type { Tool, ToolInput } from "./types.ts"

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass"

export type AskAnswer = "once" | "always" | "deny"
export type AskFn = (tool: string, input: ToolInput, detail: string) => Promise<AskAnswer>

/** Tools that file-editing permission modes auto-approve. */
export const EDIT_TOOLS = new Set(["Write", "Edit"])

export interface PermissionDecision {
  allowed: boolean
  note?: string
}

export class PermissionEngine {
  mode: PermissionMode
  private ask: AskFn
  private interactive: boolean
  private alwaysAllow = new Set<string>()

  constructor(mode: PermissionMode, ask: AskFn, interactive: boolean) {
    this.mode = mode
    this.ask = ask
    this.interactive = interactive
  }

  private keyFor(tool: Tool, input: ToolInput): string {
    // For Bash, "always" applies per command prefix (first two words).
    if (tool.name === "Bash") {
      const cmd = String(input.command ?? "").trim()
      return `Bash:${cmd.split(/\s+/).slice(0, 2).join(" ")}`
    }
    return tool.name
  }

  async check(tool: Tool, input: ToolInput): Promise<PermissionDecision> {
    if (this.mode === "bypass") return { allowed: true }

    if (this.mode === "plan" && !tool.readOnly) {
      return {
        allowed: false,
        note: "Plan mode is read-only. Finish the plan, then switch modes to apply changes.",
      }
    }

    if (tool.readOnly) return { allowed: true }

    if (this.mode === "acceptEdits" && EDIT_TOOLS.has(tool.name)) return { allowed: true }

    const key = this.keyFor(tool, input)
    if (this.alwaysAllow.has(key)) return { allowed: true }

    if (!this.interactive) {
      return {
        allowed: false,
        note: "This action needs confirmation, but the session is not interactive. Re-run with --mode acceptEdits or --mode bypass.",
      }
    }

    const detail = describeCall(tool, input)
    const answer = await this.ask(tool.name, input, detail)
    if (answer === "always") {
      this.alwaysAllow.add(key)
      return { allowed: true }
    }
    if (answer === "once") return { allowed: true }
    return { allowed: false, note: "Denied by the user." }
  }
}

/** Short, one-line description of a call (used in permission prompts and logs). */
export function formatCall(toolName: string, input: ToolInput | undefined): string {
  if (!input) return toolName
  if (toolName === "Bash") return `Bash: ${String(input.command ?? "")}`
  if (input.file_path !== undefined) return `${toolName}: ${String(input.file_path)}`
  if (input.pattern !== undefined) return `${toolName}: ${String(input.pattern)}`
  if (input.description !== undefined) return `${toolName}: ${String(input.description)}`
  return `${toolName} ${JSON.stringify(input).slice(0, 120)}`
}

export function describeCall(tool: Tool, input: ToolInput): string {
  if (tool.name === "Bash") return `Bash: ${String(input.command ?? "")}`
  if (tool.name === "Read" || tool.name === "Write" || tool.name === "Edit") {
    return `${tool.name}: ${String(input.file_path ?? "")}`
  }
  if (tool.name === "Glob") return `Glob: ${String(input.pattern ?? "")}`
  if (tool.name === "Grep") return `Grep: ${String(input.pattern ?? "")}`
  if (tool.name === "Task") return `Task: ${String(input.description ?? "")}`
  return `${tool.name} ${JSON.stringify(input).slice(0, 120)}`
}
