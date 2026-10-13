// Memory: original anvil project/user instruction files (ANVIL.md).

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MAX_MEMORY_CHARS = 20_000

/**
 * Load ANVIL.md from the working directory and the user's home (~/.anvil/ANVIL.md).
 * Returns a ready-to-append prompt section, or null when nothing exists.
 */
export function loadMemory(cwd: string): string | null {
  const parts: string[] = []
  const project = join(cwd, "ANVIL.md")
  if (existsSync(project)) {
    parts.push(`## Project instructions (ANVIL.md in the working directory)\n${readFileSync(project, "utf8").trim()}`)
  }
  const user = join(homedir(), ".anvil", "ANVIL.md")
  if (existsSync(user)) {
    parts.push(`## User instructions (~/.anvil/ANVIL.md)\n${readFileSync(user, "utf8").trim()}`)
  }
  if (parts.length === 0) return null
  const joined = parts.join("\n\n")
  return joined.length > MAX_MEMORY_CHARS
    ? joined.slice(0, MAX_MEMORY_CHARS) + "\n… [memory truncated]"
    : joined
}
