// Provider registry: kinds, defaults, and the factory used by the config
// resolver. (Key lookup and resolution live in src/config.ts.)

import type { Provider } from "../types.ts"
import { AnthropicProvider } from "./anthropic.ts"
import { OpenAIProvider } from "./openai.ts"
import { LOCAL_CONNECT_TIMEOUT_MS } from "./timeouts.ts"

export type ProviderKind = "anthropic" | "openai" | "hsnr" | "local"

export const PROVIDER_KINDS: ProviderKind[] = ["anthropic", "openai", "hsnr", "local"]

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

/** "local" talks to Ollama / LM Studio through the OpenAI-compatible
 *  endpoint. The base URL (and model) are auto-detected by src/local.ts;
 *  the fallback base is Ollama's standard location. No API key is needed —
 *  the dummy below only fills the OpenAIProvider's required argument. */
export const LOCAL_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"
export const LOCAL_DUMMY_KEY = "anvil-local"

export function defaultModelFor(kind: ProviderKind): string {
  if (kind === "anthropic") return process.env.ANVIL_MODEL || "claude-sonnet-4-5"
  if (kind === "hsnr") return process.env.ANVIL_MODEL || HSNR_DEFAULT_MODEL
  if (kind === "local") return process.env.ANVIL_MODEL || "" // "" = first model of the runtime
  return process.env.OPENAI_MODEL || "gpt-4o"
}

export function makeProvider(kind: ProviderKind, apiKey: string, baseUrl?: string): Provider {
  if (kind === "anthropic") return new AnthropicProvider(apiKey)
  // The hsnr gateway (litellm) validates chat messages strictly and rejects
  // input_file parts — PDFs must travel as extracted text there.
  if (kind === "hsnr")
    return new OpenAIProvider(apiKey, baseUrl || HSNR_DEFAULT_BASE_URL, true, undefined, false)
  if (kind === "local") return makeLocalProvider(baseUrl)
  return new OpenAIProvider(apiKey, baseUrl || "https://api.openai.com/v1")
}

/** Local runtimes (Ollama / LM Studio) may take minutes on the first
 *  request to load a model's weights — give the connect phase a long
 *  budget instead of failing after the default 30 s. */
export function makeLocalProvider(baseUrl?: string): Provider {
  return new OpenAIProvider(
    LOCAL_DUMMY_KEY,
    baseUrl || LOCAL_DEFAULT_BASE_URL,
    false,
    LOCAL_CONNECT_TIMEOUT_MS,
    false,
  )
}
