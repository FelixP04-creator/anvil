// Persistent user settings: API keys, provider, model, thinking effort.
//
// Stored as JSON in ~/.anvil.json (override the location with $ANVIL_CONFIG).
// Resolution order, highest first:
//   1. CLI flags / explicit overrides passed by the caller
//   2. environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, ANVIL_MODEL,
//      OPENAI_MODEL, OPENAI_BASE_URL)
//   3. the config file
//   4. built-in defaults

import { homedir } from "node:os"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import type { Provider, ThinkingEffort } from "./types.ts"
import type { ProviderKind } from "./providers/index.ts"
import { defaultModelFor } from "./providers/index.ts"
import { AnthropicProvider } from "./providers/anthropic.ts"
import { OpenAIProvider } from "./providers/openai.ts"

export const THINKING_LEVELS: ThinkingEffort[] = ["off", "low", "medium", "high"]

export interface FileConfig {
  provider?: ProviderKind
  model?: string
  thinking?: ThinkingEffort
  anthropicKey?: string
  openaiKey?: string
  openaiBaseUrl?: string
}

export interface SettingsOverride {
  provider?: ProviderKind
  model?: string
  thinking?: ThinkingEffort
}

export interface ResolvedSettings {
  kind: ProviderKind
  model: string
  thinking: ThinkingEffort
  provider: Provider
  /** The file as last loaded (for API responses; keys are masked there). */
  file: FileConfig
}

export function configPath(): string {
  return process.env.ANVIL_CONFIG || join(homedir(), ".anvil.json")
}

export function loadConfig(): FileConfig {
  try {
    const data: unknown = JSON.parse(readFileSync(configPath(), "utf8"))
    if (data && typeof data === "object" && !Array.isArray(data)) return data as FileConfig
    return {}
  } catch {
    return {}
  }
}

/** Merge `patch` into the stored config. Empty strings remove a field
 *  (how the web UI clears a key). Returns the merged config. */
export function saveConfig(patch: Partial<FileConfig>): FileConfig {
  const next: FileConfig = { ...loadConfig(), ...patch }
  for (const key of Object.keys(next) as (keyof FileConfig)[]) {
    const v = next[key]
    if (v === undefined || v === "") delete next[key]
  }
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
  return next
}

/** "sk-ant-ap…wxyz" — safe to show in the UI. */
export function maskKey(key: string | undefined): string | null {
  if (!key) return null
  if (key.length <= 10) return key.slice(0, 2) + "…"
  return key.slice(0, 7) + "…" + key.slice(-4)
}

function keyFor(kind: ProviderKind, file: FileConfig): string | undefined {
  if (kind === "anthropic") return process.env.ANTHROPIC_API_KEY || file.anthropicKey
  return process.env.OPENAI_API_KEY || file.openaiKey
}

/**
 * Pick provider + model + thinking from overrides, environment and the
 * config file, and build the provider instance. Throws a descriptive error
 * when no usable API key exists.
 */
export function resolveSettings(ov: SettingsOverride = {}): ResolvedSettings {
  const file = loadConfig()

  let kind: ProviderKind | undefined = ov.provider ?? file.provider
  if (!kind) {
    kind =
      process.env.ANTHROPIC_API_KEY || file.anthropicKey
        ? "anthropic"
        : process.env.OPENAI_API_KEY || file.openaiKey
          ? "openai"
          : undefined
  }
  if (!kind) {
    throw new Error(
      "No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or store one with `anvil config set <anthropic-key|openai-key> <key>` (or in the web UI settings).",
    )
  }
  const key = keyFor(kind, file)
  if (!key) {
    throw new Error(
      `The provider "${kind}" is selected but no API key is set. Set ${
        kind === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
      } or \`anvil config set ${kind}-key <key>\`.`,
    )
  }

  const envModel = kind === "anthropic" ? process.env.ANVIL_MODEL : process.env.OPENAI_MODEL
  const model = ov.model || envModel || file.model || defaultModelFor(kind)
  const thinking = ov.thinking ?? file.thinking ?? "off"

  const provider: Provider =
    kind === "anthropic"
      ? new AnthropicProvider(key)
      : new OpenAIProvider(
          key,
          process.env.OPENAI_BASE_URL || file.openaiBaseUrl || "https://api.openai.com/v1",
        )

  return { kind, model, thinking, provider, file }
}
