import type { Provider, Tool, ToolInput, ToolContext } from "../types.ts"
import { runAgent, type PermissionChecker } from "../agent.ts"

export interface SubagentDeps {
  provider: Provider
  model: string
  subagentSystem: string
  /** Tools the subagent may use (no Task itself). */
  subagentTools: Tool[]
  check: (tool: Tool, input: ToolInput) => Promise<{ allowed: boolean; note?: string }>
  maxTurns: number
}

export function createTaskTool(ctx: ToolContext, deps: SubagentDeps): Tool {
  return {
    name: "Task",
    description:
      "Delegate a self-contained subtask to a subagent that works with its own context window. " +
      "Use for parallelizable research or multi-step work whose intermediate output would clutter the main " +
      "conversation. The subagent gets the core file/shell tools but cannot delegate further. " +
      "Do not duplicate work the subagent is doing.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short label for the task (3-8 words)." },
        prompt: { type: "string", description: "Complete instructions for the subagent, including all needed context." },
      },
      required: ["description", "prompt"],
    },
    readOnly: false,
    async execute(input: ToolInput) {
      const prompt = String(input.prompt ?? "")
      if (!prompt) return { ok: false, output: "prompt is required." }
      const result = await runAgent(
        {
          provider: deps.provider,
          model: deps.model,
          system: deps.subagentSystem,
          tools: deps.subagentTools,
          permissions: { check: deps.check } as PermissionChecker,
          context: ctx,
          maxTurns: deps.maxTurns,
        },
        [{ role: "user", content: [{ type: "text", text: prompt }] }],
      )
      return { ok: true, output: `Subagent finished.\n\n${result.text}` }
    },
  }
}
