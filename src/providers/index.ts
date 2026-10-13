// Provider factory: pick by explicit flag or by which API key is present.

import type { Provider } from "../types.ts"
import { AnthropicProvider } from "./anthropic.ts"
import { OpenAIProvider } from "./openai.ts"

export type ProviderKind = "anthropic" | "openai"

export function defaultModelFor(kind: ProviderKind): string {
  if (kind === "anthropic") return process.env.ANVIL_MODEL || "claude-sonnet-4-5"
  return process.env.OPENAI_MODEL || "gpt-4o"
}

/**
 * If kind is undefined, pick the first provider whose API key is present.
 */
export function createProvider(kind: ProviderKind | undefined): { provider: Provider; kind: ProviderKind } {
  const kinds: ProviderKind[] = kind ? [kind] : ["anthropic", "openai"]
  for (const k of kinds) {
    if (k === "anthropic" && process.env.ANTHROPIC_API_KEY) {
      return { provider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY), kind: k }
    }
    if (k === "openai" && process.env.OPENAI_API_KEY) {
      const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
      return { provider: new OpenAIProvider(process.env.OPENAI_API_KEY, base), kind: k }
    }
  }
  const needed = kinds.map((k) => (k === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY")).join(" or ")
  throw new Error(`No API key found. Set ${needed} (or pick a provider with --provider).`)
}
