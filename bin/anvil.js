#!/usr/bin/env node
// Thin launcher for the `anvil` command.
// npm refuses to package .ts files as bin entries, so this tiny ESM shim
// delegates to the real CLI. Node >= 23.6 runs the TypeScript natively
// (type stripping) — no build step, no runtime dependencies.
import("../src/index.ts");
