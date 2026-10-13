// Minimal Anthropic Messages API provider (no SDK, just fetch).

import type { Provider, ProviderRequest, ProviderResponse, ToolInput } from "../types.ts"

interface AnthropicBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: ToolInput
}

interface AnthropicResponse {
  content?: AnthropicBlock[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export class AnthropicProvider implements Provider {
  name = "anthropic"
  apiKey: string
  baseUrl: string

  constructor(apiKey: string, baseUrl = "https://api.anthropic.com") {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
  }

  async complete(req: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
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
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`)
    }

    const data = (await res.json()) as AnthropicResponse
    const content = data.content ?? []
    const text = content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
    const toolUse = content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        id: b.id ?? "",
        name: b.name ?? "",
        input: (b.input ?? {}) as ToolInput,
      }))

    return {
      text,
      toolUse,
      stop: data.stop_reason === "tool_use" ? "tool_use" : "end_turn",
      usage: data.usage
        ? {
            input: data.usage.input_tokens ?? 0,
            output: data.usage.output_tokens ?? 0,
          }
        : undefined,
    }
  }
}
