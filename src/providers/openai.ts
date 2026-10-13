// OpenAI-compatible chat-completions provider with SSE streaming.
// Works with api.openai.com and compatible gateways (set OPENAI_BASE_URL).
// Supports reasoning models: reasoning_effort is sent for o-series/gpt-5
// models (or all models when forceReasoning is set, as on the hsnr gateway),
// and streamed reasoning text (reasoning_content) is surfaced.

import type { Message, Provider, ProviderRequest, ProviderResponse, ToolInput, ThinkingEffort } from "../types.ts"
import {
  CONNECT_TIMEOUT_MS,
  FIRST_CHUNK_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  connectSignal,
  withTimeout,
} from "./timeouts.ts"

interface ToolCallAcc {
  id: string
  name: string
  args: string
}

/** Models that accept reasoning_effort (o-series, gpt-5 family). */
function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase()
  return /^o\d/.test(m) || m.startsWith("gpt-5")
}

/** Thinking budgets for reasoning models, mirroring the Anthropic provider.
 *  The completion budget must cover the budget plus margin for the actual
 *  answer/tool call, or long thinking blocks truncate the output mid-JSON. */
const THINKING_BUDGETS: Record<Exclude<ThinkingEffort, "off">, number> = {
  low: 4096,
  medium: 16384,
  high: 32768,
}

/** Map anvil's effort to the API value; "off" → no override. o1 caps at
 *  medium. Non-reasoning models → undefined (parameter omitted), unless the
 *  gateway forces reasoning on all models. */
function reasoningEffortFor(
  model: string,
  effort: ThinkingEffort,
  forceReasoning = false,
): "low" | "medium" | "high" | undefined {
  if (effort === "off" || (!forceReasoning && !isReasoningModel(model))) return undefined
  if (!forceReasoning && /^o1/.test(model.toLowerCase()) && effort === "high") return "medium"
  return effort
}

/** Convert anvil's internal messages to the OpenAI chat format. Thinking
 *  blocks are not part of the OpenAI history format and are skipped. */
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
      const images = m.content.filter(
        (b): b is Extract<typeof b, { type: "image" }> => b.type === "image",
      )
      if (texts.length || images.length) {
        if (images.length === 0) {
          out.push({ role: "user", content: texts.join("") })
        } else {
          // Multimodal user turn: content becomes a part array with the
          // text first and one image_url part per attached image.
          out.push({
            role: "user",
            content: [
              ...(texts.length ? [{ type: "text", text: texts.join("") }] : []),
              ...images.map((b) => ({
                type: "image_url",
                image_url: { url: `data:${b.mediaType};base64,${b.data}` },
              })),
            ],
          })
        }
      }
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
  /** Gateways where every model takes reasoning_effort (e.g. hsnr). */
  forceReasoning: boolean

  constructor(apiKey: string, baseUrl = "https://api.openai.com/v1", forceReasoning = false) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.forceReasoning = forceReasoning
  }

  async complete(
    req: ProviderRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    onThinking?: (text: string) => void,
  ): Promise<ProviderResponse> {
    const reasoning = this.forceReasoning || isReasoningModel(req.model)
    const effort = reasoningEffortFor(req.model, req.thinking ?? "off", this.forceReasoning)
    // Reasoning tokens count against the completion budget. Reserve
    // thinking budget + margin, otherwise a long thinking block starves the
    // real answer/tool call and truncates it mid-JSON (seen on the hsnr
    // gateway: "Unterminated string in JSON" inside a Write tool call).
    const maxTokens = effort
      ? Math.max(req.maxTokens, THINKING_BUDGETS[effort] + 4096)
      : req.maxTokens
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      // gpt-5/o-series (and forced-reasoning gateways) use
      // max_completion_tokens; older models use max_tokens.
      ...(reasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      messages: [
        { role: "system", content: req.system },
        ...toOpenAIMessages(req.messages),
      ],
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    }
    if (effort) body.reasoning_effort = effort

    const conn = connectSignal(signal, CONNECT_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: conn.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      if (conn.timedOut())
        throw new Error(`OpenAI API: connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)
      throw err
    } finally {
      conn.stop()
    }

    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => "")
      throw new Error(`OpenAI API error ${res.status}: ${errBody.slice(0, 500)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let text = ""
    let thought = ""
    let finishReason = ""
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
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (!delta) return
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content
        onDelta(delta.content)
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        thought += delta.reasoning_content
        onThinking?.(delta.reasoning_content)
      }
      for (const tc of delta.tool_calls ?? []) {
        const acc = toolCalls.get(tc.index) ?? { id: "", name: "", args: "" }
        if (tc.id) acc.id = tc.id
        if (tc.function?.name) acc.name = tc.function.name
        if (tc.function?.arguments) acc.args += tc.function.arguments
        toolCalls.set(tc.index, acc)
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

    // Parse tool-call arguments defensively: under token pressure (or plain
    // generation glitches) models occasionally emit truncated or invalid
    // JSON. A raw SyntaxError here would kill the whole turn.
    const toolUse: { id: string; name: string; input: ToolInput }[] = []
    let truncatedToolCall = false
    for (const [i, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: ToolInput
      try {
        input = (JSON.parse(tc.args || "{}") ?? {}) as ToolInput
      } catch (err) {
        if (finishReason === "length") {
          // The token limit was hit inside the arguments: report the whole
          // response as truncated so the agent loop can continue it.
          truncatedToolCall = true
          break
        }
        throw new Error(
          `Malformed tool call JSON from model (${tc.name || `tool ${i + 1}`}): ${String(err).slice(0, 120)} — raw arguments: ${tc.args.slice(0, 200)}`,
        )
      }
      toolUse.push({ id: tc.id || `call_${i}`, name: tc.name, input })
    }

    if (truncatedToolCall) {
      return {
        text,
        thinking: thought || undefined,
        toolUse: [],
        stop: "max_tokens",
      }
    }

    return {
      text,
      thinking: thought || undefined,
      toolUse,
      stop: toolUse.length ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn",
    }
  }
}
