// OpenAI-compatible chat-completions provider with SSE streaming.
// Works with api.openai.com and compatible gateways (set OPENAI_BASE_URL).

import type { Message, Provider, ProviderRequest, ProviderResponse, ToolInput } from "../types.ts"

interface ToolCallAcc {
  id: string
  name: string
  args: string
}

/** Convert anvil's internal messages to the OpenAI chat format. */
function toOpenAIMessages(messages: Message[]): any[] {
  const out: any[] = []
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("")
      const toolCalls = m.content
        .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }))
      if (!text && toolCalls.length === 0) continue
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      })
    } else {
      const texts = m.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
      if (texts.length) out.push({ role: "user", content: texts.join("") })
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content })
        }
      }
    }
  }
  return out
}

export class OpenAIProvider implements Provider {
  name = "openai"
  apiKey: string
  baseUrl: string

  constructor(apiKey: string, baseUrl = "https://api.openai.com/v1") {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
  }

  async complete(
    req: ProviderRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        max_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          ...toOpenAIMessages(req.messages),
        ],
        tools: req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    })

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "")
      throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 500)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let text = ""
    const toolCalls = new Map<number, ToolCallAcc>()

    const handleData = (data: string) => {
      if (data === "[DONE]") return
      let msg: any
      try {
        msg = JSON.parse(data)
      } catch {
        return
      }
      const choice = msg.choices?.[0]
      const delta = choice?.delta
      if (!delta) return
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content
        onDelta(delta.content)
      }
      for (const tc of delta.tool_calls ?? []) {
        const acc = toolCalls.get(tc.index) ?? { id: "", name: "", args: "" }
        if (tc.id) acc.id = tc.id
        if (tc.function?.name) acc.name = tc.function.name
        if (tc.function?.arguments) acc.args += tc.function.arguments
        toolCalls.set(tc.index, acc)
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

    const toolUse = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, tc]) => ({
        id: tc.id || `call_${i}`,
        name: tc.name,
        input: (JSON.parse(tc.args || "{}") ?? {}) as ToolInput,
      }))

    return {
      text,
      toolUse,
      stop: toolUse.length ? "tool_use" : "end_turn",
    }
  }
}
