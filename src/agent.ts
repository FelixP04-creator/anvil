// The agent loop: model -> tool calls -> tool results -> model, until done.
// `messages` is the conversation history; the caller appends the new user
// message before calling and keeps the array for the next turn.
//
// Robustness:
// - transient provider errors (rate limits, overloads, network blips) are
//   retried with backoff, but only while nothing has been streamed yet;
// - a response cut off by the token limit is continued automatically
//   (up to a few times) instead of being handed back truncated;
// - extended-thinking blocks are streamed as their own events and kept in
//   the history, as the APIs require.

import type { ContentBlock, Message, Provider, ProviderResponse, Tool, ToolContext, ToolInput, ThinkingEffort } from "./types.ts"

/** Anything that can approve tool calls (PermissionEngine or a test double). */
export interface PermissionChecker {
  check(tool: Tool, input: ToolInput): Promise<{ allowed: boolean; note?: string }>
}

export interface AgentEvent {
  type:
    | "assistant_delta"
    | "assistant_text"
    | "thinking_delta"
    | "tool_start"
    | "tool_end"
    | "denied"
    | "retry"
    | "error"
    | "aborted"
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
  /** Extended-thinking budget for the provider. Default "off". */
  thinking?: ThinkingEffort
  /** Aborting stops the turn: the in-flight model call is cancelled and a
   *  pending permission prompt is treated as denied. */
  signal?: AbortSignal
  /** Base delay for the retry backoff (doubles per attempt). Overridable
   *  in tests. */
  retryBaseDelayMs?: number
  onEvent?: (e: AgentEvent) => void
}

export interface AgentResult {
  text: string
  turns: number
  usage: { input: number; output: number }
}

const MAX_TOOL_RESULT_CHARS = 50_000
const MAX_ATTEMPTS = 3
const MAX_CONTINUATIONS = 3
const CONTINUATION_NUDGE =
  "Continue exactly where you stopped. Do not repeat anything you already wrote."

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Transient errors worth one more try. */
function isRetryableError(err: unknown): boolean {
  const msg = String(err)
  if (/abort/i.test(msg)) return false
  return (
    /API error (429|500|502|503|529)\b/.test(msg) ||
    /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg)
  )
}

export async function runAgent(opts: AgentOptions, messages: Message[]): Promise<AgentResult> {
  const maxTurns = opts.maxTurns ?? 50
  const thinking = opts.thinking ?? "off"
  const retryBase = opts.retryBaseDelayMs ?? 1500
  const usage = { input: 0, output: 0 }
  let lastText = ""
  let answer = "" // final answer text, accumulated across continuations
  let continuations = 0
  let abortEmitted = false
  const emitAbort = () => {
    if (!abortEmitted) {
      abortEmitted = true
      opts.onEvent?.({ type: "aborted" })
    }
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    // --- one model completion, with retry on transient errors -------------
    let resp: ProviderResponse
    try {
      resp = await completeWithRetry(opts, messages, turn)
    } catch (err) {
      if (opts.signal?.aborted) {
        emitAbort()
        return { text: lastText || "(stopped)", turns: turn, usage }
      }
      const message = `Model error: ${String(err)}`
      opts.onEvent?.({ type: "error", text: message })
      return { text: lastText || message, turns: turn, usage }
    }
    if (resp.usage) {
      usage.input += resp.usage.input
      usage.output += resp.usage.output
    }

    // --- append the assistant message to the history -----------------------
    const blocks: ContentBlock[] = []
    if (resp.thinking) {
      // Required by the Anthropic API on the next turn; ignored elsewhere.
      blocks.push({ type: "thinking", text: resp.thinking, signature: resp.thinkingSignature })
    }
    if (resp.text) blocks.push({ type: "text", text: resp.text })
    for (const tu of resp.toolUse) blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input })
    if (blocks.length > 0) messages.push({ role: "assistant", content: blocks })

    if (resp.text) {
      lastText = resp.text
      if (resp.toolUse.length > 0) {
        // Text that accompanies tool calls is part of the work, not the
        // final answer — surface it as-is and reset the accumulation.
        answer = ""
        opts.onEvent?.({ type: "assistant_text", text: resp.text })
      } else {
        answer += resp.text
      }
    }

    // --- done? --------------------------------------------------------------
    if (resp.toolUse.length === 0) {
      // The model ran out of tokens mid-answer: nudge it to continue rather
      // than returning a truncated reply.
      if (resp.stop === "max_tokens" && resp.text && continuations < MAX_CONTINUATIONS) {
        continuations++
        messages.push({ role: "user", content: [{ type: "text", text: CONTINUATION_NUDGE }] })
        continue
      }
      if (answer) opts.onEvent?.({ type: "assistant_text", text: answer })
      return { text: answer || lastText || "(the model produced no output)", turns: turn, usage }
    }

    const results: ContentBlock[] = []
    for (const tu of resp.toolUse) {
      // Stopped mid-loop: give every remaining tool_use a result so the
      // history stays valid, then exit.
      if (opts.signal?.aborted) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "Stopped by the user.",
          is_error: true,
        })
        continue
      }
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
    if (opts.signal?.aborted) {
      emitAbort()
      return { text: lastText || "(stopped)", turns: turn, usage }
    }
  }

  return { text: lastText || "(stopped: reached the turn limit)", turns: maxTurns, usage }
}

/** One completion with retry. Retries only while no text or thinking has
 *  been streamed for this attempt — otherwise the UI would see the answer
 *  twice. */
async function completeWithRetry(
  opts: AgentOptions,
  messages: Message[],
  turn: number,
): Promise<ProviderResponse> {
  for (let attempt = 1; ; attempt++) {
    let gotOutput = false
    const mark = () => {
      gotOutput = true
    }
    try {
      return await opts.provider.complete(
        {
          model: opts.model,
          system: opts.system,
          messages,
          tools: opts.tools,
          maxTokens: 8000,
          thinking: opts.thinking,
        },
        (delta) => {
          mark()
          opts.onEvent?.({ type: "assistant_delta", text: delta })
        },
        opts.signal,
        (delta) => {
          mark()
          opts.onEvent?.({ type: "thinking_delta", text: delta })
        },
      )
    } catch (err) {
      if (opts.signal?.aborted) throw err
      if (attempt >= MAX_ATTEMPTS || gotOutput || !isRetryableError(err)) throw err
      const delay = retryDelay(attempt, opts.retryBaseDelayMs ?? 1500)
      opts.onEvent?.({
        type: "retry",
        text: `transient model error, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})…`,
      })
      await sleep(delay)
    }
  }
}

function retryDelay(attempt: number, base: number): number {
  return base * 2 ** (attempt - 1) + Math.random() * 250
}
