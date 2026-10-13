// Provider registry: kinds, defaults, and the factory used by the config
// resolver. (Key lookup and resolution live in src/config.ts.)

import type { Provider } from "../types.ts"
import { AnthropicProvider } from "./anthropic.ts"
import { OpenAIProvider } from "./openai.ts"

export type ProviderKind = "anthropic" | "openai" | "hsnr"

export const PROVIDER_KINDS: ProviderKind[] = ["anthropic", "openai", "hsnr"]

/** HSNR is an OpenAI-compatible gateway (https://ai.ide3.de/openai) with a
 *  fixed model lineup. All of its models accept reasoning_effort, so the
 *  OpenAI provider is used in forceReasoning mode. */
export const HSNR_DEFAULT_BASE_URL = "https://ai.ide3.de/openai"
export const HSNR_DEFAULT_MODEL = "Qwen/Qwen3.8-27B"
export const HSNR_MODELS = [
  "Qwen/Qwen3.8-27B",
  "zai-org/GLM-5.3",
  "ultrabrain",
  "smallbrain",
]

export function defaultModelFor(kind: ProviderKind): string {
  if (kind === "anthropic") return process.env.ANVIL_MODEL || "claude-sonnet-4-5"
  if (kind === "hsnr") return process.env.ANVIL_MODEL || HSNR_DEFAULT_MODEL
  return process.env.OPENAI_MODEL || "gpt-4o"
}

export function makeProvider(kind: ProviderKind, apiKey: string, baseUrl?: string): Provider {
  if (kind === "anthropic") return new AnthropicProvider(apiKey)
  if (kind === "hsnr") return new OpenAIProvider(apiKey, baseUrl || HSNR_DEFAULT_BASE_URL, true)
  return new OpenAIProvider(apiKey, baseUrl || "https://api.openai.com/v1")
}
