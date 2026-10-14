// Shared types for the anvil agent.

export interface ToolInput {
  [key: string]: unknown
}

export interface ToolResult {
  ok: boolean
  output: string
}

/** Mutable per-session state shared by all tools. */
export interface Todo {
  content: string
  status: "pending" | "in_progress" | "completed"
}

export interface ToolContext {
  cwd: string
  todos: Todo[]
}

export interface Tool {
  name: string
  description: string
  /** JSON Schema (object) describing the tool input. */
  inputSchema: object
  /** Read-only tools never require user confirmation. */
  readOnly: boolean
  execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>
}

// --- Provider-agnostic message model (inspired by common agent APIs) ---

/** Extended-thinking budget. "off" means the parameter is not sent. */
export type ThinkingEffort = "off" | "low" | "medium" | "high"

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: ToolInput }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  /** User-attached image. `data` is raw base64 (no data: prefix);
   *  providers convert it to their wire format (image_url / source). */
  | { type: "image"; mediaType: string; data: string }
  /** User-attached document. When `text` is present the provider inlines the
   *  text (works for every provider, incl. local runtimes); otherwise `data`
   *  is raw base64 of a binary document (in practice: PDF) that the provider
   *  must support natively (Anthropic document block, OpenAI input_file). */
  | { type: "document"; name: string; mediaType: string; text?: string; data?: string }

export interface Message {
  role: "user" | "assistant"
  content: ContentBlock[]
}

export interface ProviderRequest {
  model: string
  system: string
  messages: Message[]
  tools: Tool[]
  maxTokens: number
  /** Optional extended-thinking budget. Providers map this to their own
   *  parameter (Anthropic thinking.budget_tokens, OpenAI reasoning_effort)
   *  and ignore it for models that do not support it. */
  thinking?: ThinkingEffort
}

export interface ProviderResponse {
  /** Concatenated text blocks from the assistant turn. */
  text: string
  /** Aggregated extended-thinking text, when the model produced any. */
  thinking?: string
  /** Anthropic-only: the signature that must be returned with the thinking
   *  block in the next request. */
  thinkingSignature?: string
  toolUse: { id: string; name: string; input: ToolInput }[]
  stop: "end_turn" | "tool_use" | "max_tokens"
  usage?: { input: number; output: number }
}

export interface Provider {
  name: string
  /**
   * Run one completion. Text deltas are emitted via onDelta as they arrive
   * (streaming); optional thinking deltas via onThinking. The promise
   * resolves with the full aggregated response.
   */
  complete(
    req: ProviderRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    onThinking?: (text: string) => void,
  ): Promise<ProviderResponse>
}
