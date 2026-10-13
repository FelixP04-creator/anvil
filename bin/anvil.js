#!/usr/bin/env node
// Thin launcher for the `anvil` command.
// The published package ships compiled JavaScript in dist/ (Node refuses to
// type-strip files inside node_modules), built at publish time via `tsc` —
// see tsconfig.publish.json. No runtime dependencies, no build step for users.
import("../dist/index.js");
