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
  /** true once a completion was handed an AbortSignal (the stop wiring) */
  sawSignal = false

  constructor(script: ProviderResponse[]) {
    this.script = script
  }

  async complete(
    _req: ProviderRequest,
    onDelta: (t: string) => void,
    signal?: AbortSignal,
    onThinking?: (t: string) => void,
  ): Promise<ProviderResponse> {
    if (signal) this.sawSignal = true
    const resp = this.script.shift() ?? { text: "DONE", toolUse: [], stop: "end_turn" }
    if (resp.thinking) onThinking?.(resp.thinking)
    if (resp.text) onDelta(resp.text)
    return resp
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "anvil-server-test-"))

  // Hermetic environment: the config tests write to a temp file and must not
  // see (or be influenced by) real API keys or model env vars on this machine.
  const cfgFile = join(dir, "anvil-test-config.json")
  process.env.ANVIL_CONFIG = cfgFile
  const savedEnv: Record<string, string | undefined> = {}
  for (const k of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANVIL_MODEL",
    "OPENAI_MODEL",
  ]) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }

  const provider = new MockProvider([
    {
      thinking: "The user wants a note file. I will create it with Write.",
      text: "",
      toolUse: [tu("t1", "Write", { file_path: join(dir, "note.txt"), content: "hello anvil" })],
      stop: "tool_use",
    },
    { text: "Wrote note.txt.", toolUse: [], stop: "end_turn" },
  ])
  const server = new AnvilServer({ provider, kind: "anthropic", model: "mock-model", thinking: "off", cwd: dir })
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
  check(
    "thinking delta streamed",
    events.some((e) => e.type === "thinking_delta" && String(e.text).includes("note file")),
  )
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
  check(
    "transcript contains a thinking entry",
    (tr.entries ?? []).some((e: any) => e.role === "thinking" && String(e.text).includes("note file")),
  )

  console.log("\n— session list —")
  const list = await (await fetch(`${base}/api/sessions`)).json()
  const entry = (list.sessions ?? []).find((s: any) => s.id === id)
  check("session list contains the session", !!entry)
  check("list entry has an auto title", entry?.title === "create note.txt")
  check("list entry carries turn count", entry?.turns === 1)

  console.log("\n— config API —")
  const cfgGet0 = await (await fetch(`${base}/api/config`)).json()
  check("config view exposes config path", typeof cfgGet0.configPath === "string" && cfgGet0.configPath.length > 0)
  check(
    "config view has no stored keys initially",
    cfgGet0.anthropicKey === null && cfgGet0.openaiKey === null && cfgGet0.hasAnthropicKey === false,
    JSON.stringify(cfgGet0),
  )

  const cfgPut = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: jsonHdr,
    body: JSON.stringify({ provider: "openai", model: "gpt-5", thinking: "high", openaiKey: "sk-test-1234567890abcdef" }),
  })
  check("config saved (200)", cfgPut.status === 200)
  const cfgGet = await (await fetch(`${base}/api/config`)).json()
  check("config reflects provider", cfgGet.provider === "openai")
  check("config reflects model", cfgGet.model === "gpt-5")
  check("config reflects thinking", cfgGet.thinking === "high")
  check("config flags the stored key", cfgGet.hasOpenaiKey === true)
  check("key masked in view", cfgGet.openaiKey === "sk-test…cdef", String(cfgGet.openaiKey))

  const cfgPutBad = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: jsonHdr,
    body: JSON.stringify({ thinking: "maximal" }),
  })
  check("invalid thinking rejected", cfgPutBad.status === 400)

  const persisted = JSON.parse(await readFile(cfgFile, "utf8"))
  check(
    "config persisted to file",
    persisted.model === "gpt-5" && persisted.thinking === "high" && persisted.openaiKey === "sk-test-1234567890abcdef",
    JSON.stringify(persisted),
  )

  const createdA = await (
    await fetch(`${base}/api/sessions`, { method: "POST", headers: jsonHdr, body: JSON.stringify({}) })
  ).json()
  const stateA = await (await fetch(`${base}/api/sessions/${createdA.id}`)).json()
  check("new session inherits saved config", stateA.model === "gpt-5" && stateA.thinking === "high")

  const createdB = await (
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: jsonHdr,
      body: JSON.stringify({ model: "custom-model", thinking: "medium" }),
    })
  ).json()
  const stateB = await (await fetch(`${base}/api/sessions/${createdB.id}`)).json()
  check("session override applied", stateB.model === "custom-model" && stateB.thinking === "medium")
  check(
    "creation response carries override",
    createdB.model === "custom-model" && createdB.thinking === "medium",
  )

  // Saving model/thinking works even after the key is gone (no provider can
  // be resolved); the values are kept and shown until a key is set again.
  const cfgPutNoKey = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: jsonHdr,
    body: JSON.stringify({ openaiKey: "", model: "nokey-model", thinking: "low" }),
  })
  check("save without a resolvable key still succeeds", cfgPutNoKey.status === 200)
  const cfgGet2 = await (await fetch(`${base}/api/config`)).json()
  check("key cleared in view", cfgGet2.hasOpenaiKey === false && cfgGet2.openaiKey === null)
  check("saved model visible without resolution", cfgGet2.model === "nokey-model")
  check("saved thinking visible without resolution", cfgGet2.thinking === "low")

  console.log("\n— abort (stop the running turn) —")
  // A fresh session whose turn parks at a permission prompt, then we abort it.
  const provider2 = new MockProvider([
    { text: "", toolUse: [tu("t3", "Write", { file_path: join(dir, "abort.txt"), content: "x" })], stop: "tool_use" },
    { text: "Should not run.", toolUse: [], stop: "end_turn" },
  ])
  const server2 = new AnvilServer({ provider: provider2, kind: "anthropic", model: "mock-model", thinking: "off", cwd: dir })
  const port2 = await server2.listen(0)
  const base2 = `http://127.0.0.1:${port2}`

  const created2 = await (
    await fetch(`${base2}/api/sessions`, { method: "POST", headers: jsonHdr, body: JSON.stringify({ mode: "default" }) })
  ).json()
  const id2 = created2.id

  const started2 = await fetch(`${base2}/api/sessions/${id2}/messages`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ text: "create abort.txt" }),
  })
  check("second message accepted (202)", started2.status === 202)

  // Wait until the turn is parked at the permission prompt.
  const parked = await (async () => {
    for (let i = 0; i < 200; i++) {
      const s = await (await fetch(`${base2}/api/sessions/${id2}`)).json()
      if (s.pendingPermission) return s
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error("turn never parked at a permission prompt")
  })()
  check("second turn parked at a permission prompt", parked.pendingPermission?.toolName === "Write")

  const abortRes = await fetch(`${base2}/api/sessions/${id2}/abort`, { method: "POST" })
  check("abort accepted while busy", (await abortRes.json()).stopped === true)

  // The turn must finish and the permission must be cleared.
  const afterAbort = await (async () => {
    for (let i = 0; i < 200; i++) {
      const s = await (await fetch(`${base2}/api/sessions/${id2}`)).json()
      if (!s.busy && !s.pendingPermission) return s
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error("turn did not end after abort")
  })()
  check("session not busy after abort", afterAbort.busy === false)
  check("pending permission cleared after abort", afterAbort.pendingPermission === null)
  check("abort wired an AbortSignal to the provider", provider2.sawSignal === true)

  // Aborting an idle session is a no-op.
  const abortIdle = await (await fetch(`${base2}/api/sessions/${id2}/abort`, { method: "POST" })).json()
  check("abort when idle is a no-op", abortIdle.stopped === false)

  // Delete the session.
  const del = await fetch(`${base2}/api/sessions/${id2}`, { method: "DELETE" })
  check("session deleted", del.status === 200)
  check("deleted session → 404", (await fetch(`${base2}/api/sessions/${id2}`)).status === 404)

  await server2.close()

  console.log("\n— static UI —")
  const page = await fetch(`${base}`)
  const html = await page.text()
  check("serves index.html", page.status === 200 && html.includes("anvil"))
  check("serves styles.css", (await fetch(`${base}/styles.css`)).status === 200)
  check("serves app.js", (await fetch(`${base}/app.js`)).status === 200)
  check("path traversal blocked", (await fetch(`${base}/..%2fpackage.json`)).status === 404)

  await server.close()
  await rm(dir, { recursive: true, force: true })
  delete process.env.ANVIL_CONFIG
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v
  }
  console.log(failures === 0 ? "\nALL SERVER TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
