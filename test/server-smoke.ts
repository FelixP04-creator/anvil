// End-to-end test of the HTTP server: sessions, SSE streaming, the
// permission round-trip, and static UI serving. No API key needed.
// Run with: node test/server-smoke.ts

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AnvilServer } from "../src/server.ts"
import type { Provider, ProviderRequest, ProviderResponse, ToolInput } from "../src/types.ts"

let failures = 0
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`)
  }
}

function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      const v = probe()
      if (v !== undefined) {
        clearInterval(timer)
        resolve(v)
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer)
        reject(new Error("timeout while waiting for event"))
      }
    }, 25)
  })
}

const tu = (id: string, name: string, input: ToolInput) => ({ id, name, input })

class MockProvider implements Provider {
  name = "mock"
  script: ProviderResponse[]

  constructor(script: ProviderResponse[]) {
    this.script = script
  }

  async complete(_req: ProviderRequest, onDelta: (t: string) => void): Promise<ProviderResponse> {
    const resp = this.script.shift() ?? { text: "DONE", toolUse: [], stop: "end_turn" }
    if (resp.text) onDelta(resp.text)
    return resp
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "anvil-server-test-"))
  const provider = new MockProvider([
    { text: "", toolUse: [tu("t1", "Write", { file_path: join(dir, "note.txt"), content: "hello anvil" })], stop: "tool_use" },
    { text: "Wrote note.txt.", toolUse: [], stop: "end_turn" },
  ])
  const server = new AnvilServer({ provider, model: "mock-model", cwd: dir })
  const port = await server.listen(0)
  const base = `http://127.0.0.1:${port}`
  const jsonHdr = { "content-type": "application/json" }
  console.log(`server: ${base}\n`)

  console.log("— health & session —")
  const health = await (await fetch(`${base}/api/health`)).json()
  check("health ok", health.ok === true)

  const created = await (
    await fetch(`${base}/api/sessions`, { method: "POST", headers: jsonHdr, body: JSON.stringify({ mode: "default" }) })
  ).json()
  check("session created", typeof created.id === "string")
  const id = created.id

  const state0 = await (await fetch(`${base}/api/sessions/${id}`)).json()
  check(
    "initial state",
    state0.mode === "default" && state0.busy === false && state0.cwd === dir && state0.pendingPermission === null,
  )

  const missing = await fetch(`${base}/api/sessions/nope`)
  check("unknown session → 404", missing.status === 404)

  console.log("\n— turn with permission flow over SSE —")
  const sseRes = await fetch(`${base}/api/sessions/${id}/events`)
  check("SSE content type", (sseRes.headers.get("content-type") ?? "").includes("text/event-stream"))

  const events: any[] = []
  let resolveTurnEnd: () => void
  const turnEnd = new Promise<void>((r) => (resolveTurnEnd = r))
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const pump = (async () => {
    reader = sseRes.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5).trim()))
        }
      }
      if (events.some((e) => e.type === "turn_end")) {
        resolveTurnEnd()
        break
      }
    }
  })()

  // Let the SSE subscription register before starting the turn.
  await new Promise((r) => setTimeout(r, 150))

  const started = await fetch(`${base}/api/sessions/${id}/messages`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ text: "create note.txt" }),
  })
  check("message accepted (202)", started.status === 202)

  const stateBusy = await (await fetch(`${base}/api/sessions/${id}`)).json()
  check("session busy during turn", stateBusy.busy === true)

  const permEvent = await waitFor(() => events.find((e) => e.type === "permission_request"))
  check("permission request received", permEvent.toolName === "Write", JSON.stringify(permEvent))

  const answered = await fetch(`${base}/api/sessions/${id}/permissions`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ id: permEvent.id, answer: "once" }),
  })
  check("permission answered", (await answered.json()).ok === true)

  await turnEnd
  await pump
  await reader?.cancel()

  check("tool_start seen", events.some((e) => e.type === "tool_start" && e.toolName === "Write"))
  check("tool_end ok", events.some((e) => e.type === "tool_end" && e.toolName === "Write" && e.ok === true))
  check("assistant delta streamed", events.some((e) => e.type === "assistant_delta"))
  check("final text event", events.some((e) => e.type === "assistant_text" && String(e.text).includes("Wrote note.txt")))
  const file = await readFile(join(dir, "note.txt"), "utf8")
  check("file written through the server", file === "hello anvil")

  console.log("\n— session state & mode —")
  const state1 = await (await fetch(`${base}/api/sessions/${id}`)).json()
  check("turn counted", state1.turns === 1)
  check("not busy after turn", state1.busy === false)

  const modeRes = await fetch(`${base}/api/sessions/${id}/mode`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ mode: "plan" }),
  })
  check("mode updated", (await modeRes.json()).ok === true)
  const state2 = await (await fetch(`${base}/api/sessions/${id}`)).json()
  check("state reflects mode", state2.mode === "plan")

  const badMode = await fetch(`${base}/api/sessions/${id}/mode`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ mode: "yolo" }),
  })
  check("invalid mode rejected", badMode.status === 400)

  console.log("\n— transcript & pending permissions —")
  check("no pending permission after answer", state1.pendingPermission === null)
  const tr = await (await fetch(`${base}/api/sessions/${id}/transcript`)).json()
  check(
    "transcript contains the user turn",
    (tr.entries ?? []).some((e: any) => e.role === "user" && e.text === "create note.txt"),
  )
  check(
    "transcript tool entry carries the result",
    (tr.entries ?? []).some(
      (e: any) => e.role === "tool" && e.name === "Write" && e.ok === true && String(e.output).includes("Wrote"),
    ),
  )
  check(
    "transcript contains the answer",
    (tr.entries ?? []).some((e: any) => e.role === "assistant" && String(e.text).includes("Wrote note.txt")),
  )

  console.log("\n— static UI —")
  const page = await fetch(`${base}/`)
  const html = await page.text()
  check("serves index.html", page.status === 200 && html.includes("anvil"))
  check("serves styles.css", (await fetch(`${base}/styles.css`)).status === 200)
  check("serves app.js", (await fetch(`${base}/app.js`)).status === 200)
  check("path traversal blocked", (await fetch(`${base}/..%2fpackage.json`)).status === 404)

  await server.close()
  await rm(dir, { recursive: true, force: true })
  console.log(failures === 0 ? "\nALL SERVER TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
