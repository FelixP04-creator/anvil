// Anthropic Messages API provider with SSE streaming (no SDK, just fetch).

import type { Provider, ProviderRequest, ProviderResponse, ToolInput } from "../types.ts"

interface BlockAcc {
  kind: "text" | "tool_use"
  text: string
  id?: string
  name?: string
  json: string
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
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
  ): Promise<ProviderResponse> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages,
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        stream: true,
      }),
    })

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "")
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let stop: ProviderResponse["stop"] = "end_turn"
    let inputTokens = 0
    let outputTokens = 0
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
        case "content_block_start":
          blocks[msg.index] =
            msg.content_block?.type === "tool_use"
              ? {
                  kind: "tool_use",
                  text: "",
                  id: msg.content_block.id,
                  name: msg.content_block.name,
                  json: "",
                }
              : { kind: "text", text: "", json: "" }
          break
        case "content_block_delta": {
          const b = blocks[msg.index]
          if (!b) break
          if (msg.delta?.type === "text_delta") {
            b.text += msg.delta.text ?? ""
            onDelta(msg.delta.text ?? "")
          } else if (msg.delta?.type === "input_json_delta") {
            b.json += msg.delta.partial_json ?? ""
          }
          break
        }
        case "message_delta":
          stop = msg.delta?.stop_reason === "tool_use" ? "tool_use" : "end_turn"
          outputTokens = msg.usage?.output_tokens ?? outputTokens
          break
      }
    }

    while (true) {
      const { done, value } = await reader.read()
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
    const toolUse = blocks
      .filter((b) => b.kind === "tool_use")
      .map((b) => ({
        id: b.id ?? "",
        name: b.name ?? "",
        input: (safeParse(b.json) ?? {}) as ToolInput,
      }))

    return {
      text,
      toolUse,
      stop,
      usage: { input: inputTokens, output: outputTokens },
    }
  }
}
