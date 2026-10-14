#!/usr/bin/env node
// Build a single-file Windows EXE (anvil) via a Node Single Executable
// Application (SEA). Zero runtime dependencies: the output binary embeds the
// Node.js runtime plus the whole agent (bundled by esbuild) plus the web UI.
//
// Pipeline:
//   1. read the web/ assets (served by the exe's built-in server)
//   2. generate a tiny SEA entry that injects version + assets as globals
//      and imports the CLI entry (src/index.ts)
//   3. bundle that entry to a single CJS file with esbuild
//   4. generate the SEA blob (node --experimental-sea-config)
//   5. inject the blob into a copy of node.exe with postject
//
// Output: release/anvil-win-<arch>.exe  (~90 MB, includes Node.js).
//
// Run from anywhere:  node scripts/build-exe.mjs
import { readFileSync, writeFileSync, mkdirSync, cpSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { arch, platform } from "node:os"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const buildDir = join(root, "build")
const releaseDir = join(root, "release")
mkdirSync(buildDir, { recursive: true })
mkdirSync(releaseDir, { recursive: true })

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

// ---------------------------------------------------------------- web assets
// Everything the built-in web server can need. Served from memory inside the
// exe (src/web-assets.ts) — no web/ directory next to the binary.
const WEB_FILES = [
  "index.html",
  "app.js",
  "md.js",
  "styles.css",
  "local-chat.html",
  "local-chat.js",
]
const assets = {}
for (const f of WEB_FILES) {
  assets[f] = readFileSync(join(root, "web", f), "utf8")
}
console.log(`web assets: ${WEB_FILES.length} files, ${Math.round(Object.values(assets).join("").length / 1024)} kB`)

// ---------------------------------------------------------------- SEA entry
// The SEA main script must be a single file. It sets the globals the code
// checks for (embedded mode + version + assets) and then imports the real
// entry, which runs main() on import.
const entrySrc = [
  `globalThis.__ANVIL_VERSION__ = ${JSON.stringify(pkg.version)};`,
  `globalThis.__ANVIL_EMBEDDED__ = true;`,
  `globalThis.__ANVIL_WEB__ = ${JSON.stringify(assets)};`,
  `import ${JSON.stringify(relative(buildDir, join(root, "src", "index.ts")))};`,
  "",
].join("\n")
const entryPath = join(buildDir, "sea-entry.mjs")
writeFileSync(entryPath, entrySrc)

// ---------------------------------------------------------------- esbuild
// Bundle to CJS: Node SEA main scripts are executed as CommonJS.
const esbuild = require("esbuild")
await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node23.6",
  outfile: join(buildDir, "anvil-bundle.cjs"),
  logLevel: "warning",
})
console.log(`bundle:     ${(statSync(join(buildDir, "anvil-bundle.cjs")).size / 1024).toFixed(0)} kB`)

// ---------------------------------------------------------------- SEA blob
const seaConfigPath = join(buildDir, "sea-config.json")
const blobPath = join(buildDir, "sea-prep.blob")
writeFileSync(
  seaConfigPath,
  JSON.stringify({ main: join(buildDir, "anvil-bundle.cjs"), output: blobPath, useSnapshot: false }),
)
execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" })

// ---------------------------------------------------------------- postject
// Node >= 25 looks up the injected blob under the PE resource name
// NODE_SEA_BLOB (older docs said SEABLOB — a name mismatch makes the binary
// crash at startup: fuse set, blob not found, NULL deref — nodejs/node#63466).
const outExe = join(releaseDir, `anvil-win-${arch()}.exe`)
cpSync(process.execPath, outExe)
const postjectCli = join(root, "node_modules", "postject", "dist", "cli.js")
execFileSync(
  process.execPath,
  [
    postjectCli,
    outExe,
    "NODE_SEA_BLOB",
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    blobPath,
  ],
  { stdio: "inherit" },
)

const sizeMb = (statSync(outExe).size / 1024 / 1024).toFixed(1)
console.log(`\nBuilt ${outExe} (${sizeMb} MB)`)
if (platform() === "win32") {
  console.log("Note: the exe is unsigned — SmartScreen may ask before the first run.")
}
