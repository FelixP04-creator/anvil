// Start the server with a scripted mock provider and a pre-seeded demo
// conversation. No API key required — handy for trying the web UI.
//
//   node scripts/demo-server.ts [--port 8901]
//
// Run this from the repository root. It prints the URL of a session that
// has one finished turn and one turn waiting at a permission prompt.

import { AnvilServer } from "../src/server.ts"
import type { Provider, ProviderRequest, ProviderResponse, ToolInput } from "../src/types.ts"

const tu = (id: string, name: string, input: ToolInput) => ({ id, name, input })

const MARKDOWN_ANSWER = `anvil is built around one small agent loop in \`src/agent.ts\` — every turn sends the conversation and tool schemas to the model, then executes whatever the model asked for.

## How a turn works

1. The model streams text back as \`assistant_delta\` events
2. Each tool call runs through the **permission engine**
3. Results are appended to the history and the loop continues

\`\`\`ts
for (let turn = 1; turn <= maxTurns; turn++) {
  const resp = await provider.complete(request, onDelta, signal)
  if (resp.toolUse.length === 0) return finish()
  await runTools(resp.toolUse)
}
\`\`\`

It is deliberately tiny: eight tools, zero dependencies, and the whole loop fits on one screen.`

class DemoProvider implements Provider {
  name = "demo"
  script: ProviderResponse[]

  constructor(script: ProviderResponse[]) {
    this.script = script
  }

  async complete(_req: ProviderRequest, onDelta: (t: string) => void): Promise<ProviderResponse> {
    const resp = this.script.shift() ?? { text: "DONE", toolUse: [], stop: "end_turn" }
    if (resp.text) {
      for (let i = 0; i < resp.text.length; i += 18) onDelta(resp.text.slice(i, i + 18))
    }
    return resp
  }
}

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function waitForState(
  base: string,
  id: string,
  probe: (s: Record<string, unknown>) => boolean,
  timeoutMs = 15000,
): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const s = await (await fetch(`${base}/api/sessions/${id}`)).json()
    if (probe(s)) return
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for the demo state")
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function main(): Promise<void> {
  const port = parseInt(argValue("--port", "8901"), 10)
  const cwd = process.cwd()

  const provider = new DemoProvider([
    // Turn 1 (finishes): two read-only tools, then a markdown answer.
    { text: "", toolUse: [tu("d1", "Glob", { pattern: "src/**/*.ts" })], stop: "tool_use" },
    { text: "", toolUse: [tu("d2", "Read", { file_path: "src/agent.ts", limit: 25 })], stop: "tool_use" },
    { text: MARKDOWN_ANSWER, toolUse: [], stop: "end_turn" },
    // Turn 2 (stops at the permission prompt): track the work, then a
    // Write that nobody approves yet.
    {
      text: "Sure — I will track this with a short task list and create the file.\n\n",
      toolUse: [
        tu("d3", "TodoWrite", {
          todos: [
            { content: "Inspect the project layout", status: "completed" },
            { content: "Create README-EXAMPLE.md", status: "in_progress" },
            { content: "Verify the example renders", status: "pending" },
          ],
        }),
        tu("d4", "Write", { file_path: "README-EXAMPLE.md", content: "# Example\n\nCreated by the anvil demo.\n" }),
      ],
      stop: "tool_use",
    },
  ])

  const server = new AnvilServer({ provider, model: "demo-model (mock)", cwd })
  const actualPort = await server.listen(port)
  const base = `http://localhost:${actualPort}`

  const created = await (
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "default" }),
    })
  ).json()
  const id: string = created.id

  const send = (text: string) =>
    fetch(`${base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })

  await send("explain the project layout")
  await waitForState(base, id, (s) => s.busy === false)

  await send("create a README-EXAMPLE.md with a short header")
  await waitForState(base, id, (s) => Boolean(s.pendingPermission))

  console.log("anvil demo (no API key needed) is ready:")
  console.log("")
  console.log(`  ${base}/?session=${id}`)
  console.log("")
  console.log("The session has one finished turn and one turn waiting at a permission prompt.")
  console.log("Ctrl+C to stop.")
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
