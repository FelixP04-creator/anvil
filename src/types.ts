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

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: ToolInput }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }

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
}

export interface ProviderResponse {
  /** Concatenated text blocks from the assistant turn. */
  text: string
  toolUse: { id: string; name: string; input: ToolInput }[]
  stop: "end_turn" | "tool_use" | "max_tokens"
  usage?: { input: number; output: number }
}

export interface Provider {
  name: string
  /**
   * Run one completion. Text deltas are emitted via onDelta as they arrive
   * (streaming); the promise resolves with the full aggregated response.
   */
  complete(
    req: ProviderRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ProviderResponse>
}
