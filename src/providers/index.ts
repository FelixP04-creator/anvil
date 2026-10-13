// Provider registry: kinds, defaults, and the factory used by the config
// resolver. (Key lookup and resolution live in src/config.ts.)

import type { Provider } from "../types.ts"
import { AnthropicProvider } from "./anthropic.ts"
import { OpenAIProvider } from "./openai.ts"

export type ProviderKind = "anthropic" | "openai"

export const PROVIDER_KINDS: ProviderKind[] = ["anthropic", "openai"]

export function defaultModelFor(kind: ProviderKind): string {
  if (kind === "anthropic") return process.env.ANVIL_MODEL || "claude-sonnet-4-5"
  return process.env.OPENAI_MODEL || "gpt-4o"
}

export function makeProvider(kind: ProviderKind, apiKey: string, baseUrl?: string): Provider {
  if (kind === "anthropic") return new AnthropicProvider(apiKey)
  return new OpenAIProvider(apiKey, baseUrl || "https://api.openai.com/v1")
}
