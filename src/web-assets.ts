// Web assets embedded into the single-file exe (Windows SEA build).
// The build script (scripts/build-exe.mjs) injects them as
// globalThis.__ANVIL_WEB__ before the CLI bundle runs. In normal
// checkout/npm operation the object is absent and the server serves
// the web/ directory from disk instead.

const g = globalThis as { __ANVIL_WEB__?: Record<string, string> }

/** Look up an embedded web asset by its path relative to web/. */
export function embeddedWeb(name: string): string | null {
  const assets = g.__ANVIL_WEB__
  if (!assets) return null
  const value = assets[name]
  return typeof value === "string" ? value : null
}
