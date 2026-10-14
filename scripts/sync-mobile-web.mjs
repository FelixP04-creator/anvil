#!/usr/bin/env node
// Copies the offline (WebGPU) chat page from web/ into the mobile app shell
// (mobile/public/). Run this before `npx cap sync` / any app build so the
// bundled app always ships the current offline page:
//
//   node scripts/sync-mobile-web.mjs
//
// The main server UI is NOT copied — the mobile app loads it cross-origin
// from the anvil server (iframe), so only the self-contained offline page
// and its shared assets need to be embedded in the app.
import { copyFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const src = join(root, "web")
const dst = join(root, "mobile", "public")

// local-chat.html loads these relative to itself (/styles.css, /md.js).
const FILES = ["local-chat.html", "local-chat.js", "styles.css", "md.js"]

mkdirSync(dst, { recursive: true })
for (const f of FILES) {
  copyFileSync(join(src, f), join(dst, f))
  console.log(`synced ${f}`)
}
console.log(`mobile/public is up to date (${FILES.length} files)`)
