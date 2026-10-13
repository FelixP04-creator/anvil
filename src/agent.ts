// The agent loop: model -> tool calls -> tool results -> model, until done.

import type { ContentBlock, Message, Provider, Tool, ToolContext, ToolInput } from "./types.ts"

/** Anything that can approve tool calls (PermissionEngine or a test double). */
export interface PermissionChecker {
  check(tool: Tool, input: ToolInput): Promise<{ allowed: boolean; note?: string }>
}

export interface AgentEvent {
  type: "assistant_text" | "tool_start" | "tool_end" | "denied" | "error"
  text?: string
  toolName?: string
  input?: ToolInput
  ok?: boolean
}

export interface AgentOptions {
  provider: Provider
  model: string
  system: string
  tools: Tool[]
  permissions: PermissionChecker
  context: ToolContext
  maxTurns?: number
  onEvent?: (e: AgentEvent) => void
}

export interface AgentResult {
  text: string
  turns: number
  usage: { input: number; output: number }
}

const MAX_TOOL_RESULT_CHARS = 50_000

export async function runAgent(opts: AgentOptions, firstText: string): Promise<AgentResult> {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: firstText }] }]
  const maxTurns = opts.maxTurns ?? 50
  const usage = { input: 0, output: 0 }
  let lastText = ""

  for (let turn = 1; turn <= maxTurns; turn++) {
    let resp
    try {
      resp = await opts.provider.complete({
        model: opts.model,
        system: opts.system,
        messages,
        tools: opts.tools,
        maxTokens: 8000,
      })
    } catch (err) {
      const message = `Model error: ${String(err)}`
      opts.onEvent?.({ type: "error", text: message })
      return { text: lastText || message, turns: turn, usage }
    }
    if (resp.usage) {
      usage.input += resp.usage.input
      usage.output += resp.usage.output
    }

    const blocks: ContentBlock[] = []
    if (resp.text) blocks.push({ type: "text", text: resp.text })
    for (const tu of resp.toolUse) blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input })
    if (blocks.length > 0) messages.push({ role: "assistant", content: blocks })

    if (resp.text) {
      lastText = resp.text
      opts.onEvent?.({ type: "assistant_text", text: resp.text })
    }
    if (resp.toolUse.length === 0) {
      return { text: lastText || "(the model produced no output)", turns: turn, usage }
    }

    const results: ContentBlock[] = []
    for (const tu of resp.toolUse) {
      opts.onEvent?.({ type: "tool_start", toolName: tu.name, input: tu.input })
      const tool = opts.tools.find((t) => t.name === tu.name)
      let result: { ok: boolean; output: string }
      if (!tool) {
        result = {
          ok: false,
          output: `Unknown tool: ${tu.name}. Available tools: ${opts.tools.map((t) => t.name).join(", ")}.`,
        }
      } else {
        const decision = await opts.permissions.check(tool, tu.input)
        if (!decision.allowed) {
          opts.onEvent?.({ type: "denied", toolName: tu.name, text: decision.note })
          result = { ok: false, output: `Permission denied: ${decision.note ?? "not allowed in the current mode"}` }
        } else {
          try {
            result = await tool.execute(tu.input, opts.context)
          } catch (err) {
            result = { ok: false, output: `Tool error: ${String(err)}` }
          }
        }
      }
      opts.onEvent?.({ type: "tool_end", toolName: tu.name, ok: result.ok, text: result.output })
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.output.slice(0, MAX_TOOL_RESULT_CHARS),
        is_error: !result.ok,
      })
    }
    messages.push({ role: "user", content: results })
  }

  return { text: lastText || "(stopped: reached the turn limit)", turns: maxTurns, usage }
}
