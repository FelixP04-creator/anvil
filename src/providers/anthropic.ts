// Anthropic Messages API provider with SSE streaming (no SDK, just fetch).
// Supports extended thinking: the budget is sent when the model supports it,
// thinking blocks are streamed back and preserved in the history (with their
// signature, which the API requires on the next turn).

import type { Message, Provider, ProviderRequest, ProviderResponse, ToolInput, ThinkingEffort } from "../types.ts"
import {
  CONNECT_TIMEOUT_MS,
  FIRST_CHUNK_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  connectSignal,
  withTimeout,
} from "./timeouts.ts"

interface BlockAcc {
  kind: "text" | "thinking" | "tool_use"
  text: string
  id?: string
  name?: string
  json: string
  signature?: string
}

/** Models that accept the `thinking` parameter (Claude 3.5+, 3.7 and 4.x). */
const THINKING_CAPABLE = /claude-(sonnet|opus|haiku)-[4-9]\b|claude-3[-.](5|7)([-.]|$)/

const THINKING_BUDGETS: Record<Exclude<ThinkingEffort, "off">, number> = {
  low: 4096,
  medium: 16384,
  high: 32768,
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

/** Map anvil's internal messages to the wire format (only thinking blocks
 *  use a different field name). */
function toApiMessages(messages: Message[]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === "thinking") {
        const out: Record<string, unknown> = { type: "thinking", thinking: b.text }
        if (b.signature) out.signature = b.signature
        return out
      }
      if (b.type === "image") {
        return {
          type: "image",
          source: { type: "base64", media_type: b.mediaType, data: b.data },
        }
      }
      return b
    }),
  }))
}

export class AnthropicProvider implements Provider {
  name = "anthropic"
  apiKey: string
  baseUrl: string

  constructor(apiKey: string, baseUrl = "https://api.anthropic.com") {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
  }

  async complete(
    req: ProviderRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    onThinking?: (text: string) => void,
  ): Promise<ProviderResponse> {
    let maxTokens = req.maxTokens
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: maxTokens,
      system: req.system,
      messages: toApiMessages(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      stream: true,
    }
    if (req.thinking && req.thinking !== "off" && THINKING_CAPABLE.test(req.model)) {
      const budget = THINKING_BUDGETS[req.thinking]
      // Anthropic requires max_tokens > budget_tokens.
      maxTokens = Math.max(maxTokens, budget + 4096)
      body.max_tokens = maxTokens
      body.thinking = { type: "enabled", budget_tokens: budget }
    }

    const conn = connectSignal(signal, CONNECT_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        signal: conn.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      if (conn.timedOut())
        throw new Error(`Anthropic API: connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)
      throw err
    } finally {
      conn.stop()
    }

    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => "")
      throw new Error(`Anthropic API error ${res.status}: ${errBody.slice(0, 500)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let stop: ProviderResponse["stop"] = "end_turn"
    let inputTokens = 0
    let outputTokens = 0
    let thinkingTokens = 0
    const blocks: BlockAcc[] = []

    const handleData = (data: string) => {
      if (data === "[DONE]") return
      let msg: any
      try {
        msg = JSON.parse(data)
      } catch {
        return
      }
      switch (msg.type) {
        case "message_start":
          inputTokens = msg.message?.usage?.input_tokens ?? 0
          break
        case "content_block_start": {
          const t = msg.content_block?.type
          blocks[msg.index] =
            t === "tool_use"
              ? {
                  kind: "tool_use",
                  text: "",
                  id: msg.content_block.id,
                  name: msg.content_block.name,
                  json: "",
                }
              : t === "thinking"
                ? { kind: "thinking", text: "", json: "" }
                : { kind: "text", text: "", json: "" }
          break
        }
        case "content_block_delta": {
          const b = blocks[msg.index]
          if (!b) break
          if (msg.delta?.type === "text_delta") {
            b.text += msg.delta.text ?? ""
            onDelta(msg.delta.text ?? "")
          } else if (msg.delta?.type === "thinking_delta") {
            b.text += msg.delta.thinking ?? ""
            onThinking?.(msg.delta.thinking ?? "")
          } else if (msg.delta?.type === "input_json_delta") {
            b.json += msg.delta.partial_json ?? ""
          }
          break
        }
        case "content_block_stop": {
          // The thinking signature rides on the stop event and must be
          // returned with the block in the next request.
          if (msg.signature && blocks[msg.index]) blocks[msg.index].signature = msg.signature
          break
        }
        case "message_delta": {
          const reason = msg.delta?.stop_reason
          stop = reason === "tool_use" ? "tool_use" : reason === "max_tokens" ? "max_tokens" : "end_turn"
          outputTokens = msg.usage?.output_tokens ?? outputTokens
          thinkingTokens = msg.usage?.thinking_tokens ?? 0
          break
        }
      }
    }

    let firstChunk = true
    while (true) {
      let chunk
      try {
        chunk = await withTimeout(
          reader.read(),
          firstChunk ? FIRST_CHUNK_TIMEOUT_MS : IDLE_TIMEOUT_MS,
          firstChunk ? "waiting for the model's first token timed out" : "model stream stalled",
        )
      } catch (err) {
        reader.cancel().catch(() => {})
        throw err
      }
      firstChunk = false
      const { done, value } = chunk
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("data:")) handleData(line.slice(5).trim())
        }
      }
    }
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data:")) handleData(line.slice(5).trim())
      }
    }

    const text = blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("")
    const thought = blocks
      .filter((b) => b.kind === "thinking")
      .map((b) => b.text)
      .join("\n\n")
    const firstSig = blocks.find((b) => b.kind === "thinking" && b.signature)?.signature
    const toolUse = blocks
      .filter((b) => b.kind === "tool_use")
      .map((b) => ({
        id: b.id ?? "",
        name: b.name ?? "",
        input: (safeParse(b.json) ?? {}) as ToolInput,
      }))

    return {
      text,
      thinking: thought || undefined,
      thinkingSignature: firstSig,
      toolUse,
      stop,
      usage: { input: inputTokens, output: outputTokens + thinkingTokens },
    }
  }
}
