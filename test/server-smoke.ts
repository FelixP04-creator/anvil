// End-to-end test of the HTTP server: sessions, SSE streaming, the
// permission round-trip, and static UI serving. No API key needed.
// Run with: node test/server-smoke.ts

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { AnvilServer } from "../src/server.ts"
import { detectLocal } from "../src/local.ts"
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
    "OWUI_API_KEY",
    "HSNR_BASE_URL",
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
      usage: { input: 11, output: 7 },
    },
    { text: "Wrote note.txt.", toolUse: [], stop: "end_turn", usage: { input: 13, output: 4 } },
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

  const fc1 = events.find((e: any) => e.type === "file_change")
  check(
    "file_change event emitted for Write",
    fc1?.path === join(dir, "note.txt") && fc1?.kind === "write" && fc1?.additions === 1 && fc1?.deletions === 0,
    JSON.stringify(fc1),
  )
  check(
    "file_change carries the diff rows",
    Array.isArray(fc1?.diff) && fc1?.diff?.some((l: any) => l.t === "add" && l.text === "hello anvil"),
    JSON.stringify(fc1?.diff),
  )
  const te = events.find((e: any) => e.type === "turn_end")
  check(
    "turn_end carries per-turn usage",
    typeof te?.usage?.input === "number" && typeof te?.usage?.output === "number" && te.usage.input === 24 && te.usage.output === 11,
    JSON.stringify(te?.usage),
  )
  check(
    "turn_end lists the file changes",
    Array.isArray(te?.changes) && te.changes.length === 1 && te.changes[0]?.path === join(dir, "note.txt"),
  )
  check("turn_end carries msgCount", typeof te?.msgCount === "number" && te.msgCount === 4, `msgCount=${te?.msgCount}`)
  const atEv = events.find((e: any) => e.type === "assistant_text")
  check("assistant_text carries the fork point", atEv?.msgIndex === 3, `msgIndex=${atEv?.msgIndex}`)

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

  console.log("\n— model switching (PATCH session) —")
  const patchRes = await fetch(`${base}/api/sessions/${id}`, {
    method: "PATCH",
    headers: jsonHdr,
    body: JSON.stringify({ model: "custom-model", thinking: "medium" }),
  })
  check("model switch accepted (200)", patchRes.status === 200)
  const patched = await patchRes.json()
  check(
    "patch response carries the new settings",
    patched.model === "custom-model" && patched.thinking === "medium",
  )
  const statePatch = await (await fetch(`${base}/api/sessions/${id}`)).json()
  check("state reflects the new model", statePatch.model === "custom-model")
  check("state reflects the new thinking", statePatch.thinking === "medium")
  const patchEmpty = await fetch(`${base}/api/sessions/${id}`, {
    method: "PATCH",
    headers: jsonHdr,
    body: JSON.stringify({ model: "   " }),
  })
  check("blank model rejected", patchEmpty.status === 400)
  const patchBadThinking = await fetch(`${base}/api/sessions/${id}`, {
    method: "PATCH",
    headers: jsonHdr,
    body: JSON.stringify({ thinking: "maximal" }),
  })
  check("invalid thinking rejected", patchBadThinking.status === 400)
  const patchNothing = await fetch(`${base}/api/sessions/${id}`, {
    method: "PATCH",
    headers: jsonHdr,
    body: JSON.stringify({}),
  })
  check("empty patch rejected", patchNothing.status === 400)

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

  /** Open SSE, post a message, collect events until turn_end, then cancel. */
  async function runTurn(
    sid: string,
    body: Record<string, unknown>,
    onEvent?: (e: any) => Promise<void> | void,
  ): Promise<any[]> {
    const sseRes = await fetch(`${base}/api/sessions/${sid}/events`)
    const events: any[] = []
    const done = new Promise<void>((resolve) => {
      let settled = false
      const p = (async () => {
        const reader = sseRes.body!.getReader()
        const decoder = new TextDecoder()
        let buf = ""
        for (;;) {
          const { done: d, value } = await reader.read()
          if (d) break
          buf += decoder.decode(value, { stream: true })
          let sep: number
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            for (const line of raw.split("\n")) {
              if (!line.startsWith("data:")) continue
              const e = JSON.parse(line.slice(5).trim())
              events.push(e)
              if (!settled && e.type === "turn_end") {
                settled = true
                resolve()
              }
              if (onEvent) await onEvent(e)
            }
          }
          if (settled) {
            await reader.cancel().catch(() => {})
            break
          }
        }
      })()
      void p
    })
    await new Promise((r) => setTimeout(r, 120))
    const res = await fetch(`${base}/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: jsonHdr,
      body: JSON.stringify(body),
    })
    if (res.status !== 202) throw new Error(`message not accepted (HTTP ${res.status})`)
    await done
    return events
  }

  console.log("\n— edit turn (file_change on Edit) —")
  // The mode tests above left the session in "plan" mode, where Write/Edit
  // are denied outright — switch to acceptEdits so the turn runs unattended.
  const modeReset = await fetch(`${base}/api/sessions/${id}/mode`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ mode: "acceptEdits" }),
  })
  check("mode reset to acceptEdits", (await modeReset.json()).ok === true)

  provider.script.push(
    {
      text: "",
      toolUse: [tu("t5", "Edit", { file_path: join(dir, "note.txt"), old_string: "hello anvil", new_string: "hello anvil v2" })],
      stop: "tool_use",
      usage: { input: 15, output: 6 },
    },
    { text: "Updated the note.", toolUse: [], stop: "end_turn", usage: { input: 9, output: 3 } },
  )
  const events2 = await runTurn(id, { text: "update note.txt" }, async (e) => {
    if (e.type === "permission_request") {
      await fetch(`${base}/api/sessions/${id}/permissions`, {
        method: "POST",
        headers: jsonHdr,
        body: JSON.stringify({ id: e.id, answer: "once" }),
      })
    }
  })
  const fc2 = events2.find((e: any) => e.type === "file_change")
  check(
    "file_change emitted for Edit (1 add, 1 del)",
    fc2?.kind === "edit" && fc2?.additions === 1 && fc2?.deletions === 1,
    JSON.stringify(fc2),
  )
  check(
    "edit diff shows the replaced line",
    fc2?.diff?.some((l: any) => l.t === "del" && l.text === "hello anvil") &&
      fc2?.diff?.some((l: any) => l.t === "add" && l.text === "hello anvil v2"),
    JSON.stringify(fc2?.diff),
  )
  check("file updated through the server", (await readFile(join(dir, "note.txt"), "utf8")) === "hello anvil v2")
  const stateEdits = await (await fetch(`${base}/api/sessions/${id}`)).json()
  check(
    "state carries the last turn's changes",
    Array.isArray(stateEdits.changes) && stateEdits.changes.length === 1 && stateEdits.changes[0]?.kind === "edit",
    JSON.stringify(stateEdits.changes?.map((c: any) => c.kind)),
  )

  console.log("\n— image message —")
  provider.script.push({ text: "I see the picture.", toolUse: [], stop: "end_turn", usage: { input: 21, output: 5 } })
  const imgB64 = Buffer.from("fake-png-bytes-for-anvil").toString("base64")
  const events3 = await runTurn(id, {
    text: "what do you see?",
    images: [{ mediaType: "image/png", data: imgB64 }],
  })
  check("image answer streamed", events3.some((e: any) => e.type === "assistant_text" && String(e.text).includes("picture")))
  const tr3 = await (await fetch(`${base}/api/sessions/${id}/transcript`)).json()
  const userImg = (tr3.entries ?? []).find((e: any) => e.role === "user" && Array.isArray(e.images) && e.images.length === 1)
  check(
    "transcript keeps the attached image",
    userImg?.images?.[0]?.mediaType === "image/png" && userImg?.images?.[0]?.data === imgB64,
    JSON.stringify(userImg?.images),
  )
  const badImg = await fetch(`${base}/api/sessions/${id}/messages`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ images: [{ mediaType: "text/plain", data: "zz" }] }),
  })
  check("non-image attachment rejected (400)", badImg.status === 400, `status=${badImg.status}`)

  console.log("\n— fork —")
  const forkRes = await fetch(`${base}/api/sessions/${id}/fork`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ msgIndex: 0 }),
  })
  check("fork accepted (201)", forkRes.status === 201)
  const forked = await forkRes.json()
  check("fork has a new id", typeof forked.id === "string" && forked.id !== id)
  check(
    "fork records its origin",
    forked.forkedFrom?.id === id && forked.forkedFrom?.at === 0,
    JSON.stringify(forked.forkedFrom),
  )
  const forkState = await (await fetch(`${base}/api/sessions/${forked.id}`)).json()
  check("fork history cut at the point", forkState.msgCount === 1, `msgCount=${forkState.msgCount}`)
  const forkTr = await (await fetch(`${base}/api/sessions/${forked.id}/transcript`)).json()
  check(
    "fork transcript holds only the first turn",
    (forkTr.entries ?? []).length === 1 && forkTr.entries[0]?.role === "user",
    JSON.stringify(forkTr.entries),
  )

  // A fork point inside a tool_use/tool_result pair is clamped back to the
  // previous message boundary (msgIndex 1 is the first assistant tool_use).
  const forkRes2 = await fetch(`${base}/api/sessions/${id}/fork`, {
    method: "POST",
    headers: jsonHdr,
    body: JSON.stringify({ msgIndex: 1 }),
  })
  const forked2 = await forkRes2.json()
  check(
    "fork clamps off tool_use messages",
    forkRes2.status === 201 && forked2.forkedFrom?.at === 0,
    JSON.stringify(forked2.forkedFrom),
  )

  const forkRes3 = await fetch(`${base}/api/sessions/${id}/fork`, { method: "POST", headers: jsonHdr, body: JSON.stringify({}) })
  check("fork without msgIndex duplicates the session", forkRes3.status === 201)

  const emptySess = await (
    await fetch(`${base}/api/sessions`, { method: "POST", headers: jsonHdr, body: JSON.stringify({}) })
  ).json()
  const forkEmpty = await fetch(`${base}/api/sessions/${emptySess.id}/fork`, { method: "POST", headers: jsonHdr, body: JSON.stringify({}) })
  check("fork of an empty session → 400", forkEmpty.status === 400)

  console.log("\n— persistence —")
  const sessionsDir = join(dir, ".anvil", "anvil-sessions")
  const sessionFile = join(sessionsDir, `${id}.json`)
  const diskRaw = await (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        return await readFile(sessionFile, "utf8")
      } catch {
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    return null
  })()
  check("session file written next to config", diskRaw !== null && JSON.parse(diskRaw).id === id)
  check("session file stores usage totals", JSON.parse(diskRaw!).usage.input === 69 && JSON.parse(diskRaw!).usage.output === 25, JSON.stringify(JSON.parse(diskRaw!).usage))

  const sessList = await (await fetch(`${base}/api/sessions`)).json()
  const listEntry = (sessList.sessions ?? []).find((s: any) => s.id === id)
  check("session list contains the persisted session", !!listEntry)
  check("list entry carries usage totals", listEntry?.usage?.input === 69 && listEntry?.usage?.output === 25, JSON.stringify(listEntry?.usage))
  check("list entry carries updatedAt", typeof listEntry?.updatedAt === "number")

  console.log("\n— persistence: adoption across a restart —")
  const server3 = new AnvilServer({ provider: new MockProvider([]), kind: "anthropic", model: "mock-model", thinking: "off", cwd: dir })
  const port3 = await server3.listen(0)
  const base3 = `http://127.0.0.1:${port3}`
  const list3 = await (await fetch(`${base3}/api/sessions`)).json()
  check("second server lists persisted sessions", (list3.sessions ?? []).some((s: any) => s.id === id))

  const adoptState = await fetch(`${base3}/api/sessions/${id}`)
  check("second server adopts the session on demand", adoptState.status === 200)
  const adoptBody = await adoptState.json()
  check("adopted session keeps its history", adoptBody.msgCount === 10, `msgCount=${adoptBody.msgCount}`)
  check("adopted session is idle", adoptBody.busy === false)
  check("adopted session keeps its model override", adoptBody.model === "custom-model", `model=${adoptBody.model}`)

  // Deleting from the second server removes the on-disk file.
  const delFork = await fetch(`${base3}/api/sessions/${forked2.id}`, { method: "DELETE" })
  check("delete on second server ok", delFork.status === 200)
  const forkFileGone = await readFile(join(sessionsDir, `${forked2.id}.json`), "utf8").catch(() => null)
  check("delete removes the on-disk file", forkFileGone === null)

  await server3.close()

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

  // hsnr: an OpenAI-compatible gateway provider with its own key env var
  // (OWUI_API_KEY), default model and fixed lineup.
  process.env.OWUI_API_KEY = "owui-test-key-abcdefgh1234"
  const cfgPutHsnr = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: jsonHdr,
    body: JSON.stringify({ provider: "hsnr", model: "" }),
  })
  check("hsnr config saved (200)", cfgPutHsnr.status === 200)
  const cfgHsnr = await (await fetch(`${base}/api/config`)).json()
  check("hsnr provider resolved from env key", cfgHsnr.provider === "hsnr")
  check("hsnr key flagged in view", cfgHsnr.hasHsnrKey === true)
  check("hsnr key masked in view", cfgHsnr.hsnrKey === "owui-te…1234", String(cfgHsnr.hsnrKey))
  check("hsnr default model picked", cfgHsnr.model === "Qwen/Qwen3.8-27B", cfgHsnr.model)
  const cfgHsnr2 = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: jsonHdr,
    body: JSON.stringify({ model: "ultrabrain", thinking: "medium" }),
  })
  check("hsnr model override saved", cfgHsnr2.status === 200)
  const cfgHsnr3 = await (await fetch(`${base}/api/config`)).json()
  check("hsnr model override reflected", cfgHsnr3.model === "ultrabrain" && cfgHsnr3.thinking === "medium")
  delete process.env.OWUI_API_KEY

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

  console.log("\n— local provider (Ollama / LM Studio) —")
  // A tiny OpenAI-compatible mock runtime on an ephemeral port.
  const mockModels = ["mock-llm-1", "mock-llm-2"]
  const mockHttp = createHttpServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: mockModels.map((id) => ({ id, object: "model" })) }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => mockHttp.listen(0, "127.0.0.1", () => r()))
  const mockBase = `http://127.0.0.1:${(mockHttp.address() as { port: number }).port}/v1`

  const detected = await detectLocal(mockBase, true)
  check("detectLocal finds the mock runtime", detected?.vendor === "custom" && detected?.baseUrl === mockBase, JSON.stringify(detected))
  check("detectLocal lists the models", detected?.models?.join(",") === mockModels.join(","), JSON.stringify(detected?.models))
  const dead = await detectLocal("http://127.0.0.1:1/v1", true)
  check("detectLocal returns null for a closed port", dead === null)

  // The endpoint reports what it can reach (env override, forced probe).
  process.env.ANVIL_LOCAL_BASE_URL = "http://127.0.0.1:1/v1"
  const lmDead = await (await fetch(`${base}/api/local-models`)).json()
  check("local-models: closed port → ok:false", lmDead.ok === false && /no local runtime/i.test(lmDead.error), JSON.stringify(lmDead))
  process.env.ANVIL_LOCAL_BASE_URL = mockBase
  const lmOk = await (await fetch(`${base}/api/local-models`)).json()
  check("local-models: mock runtime → ok:true", lmOk.ok === true && lmOk.models?.length === 2, JSON.stringify(lmOk))

  // Out-of-the-box path: no API keys anywhere, but a local runtime
  // reachable via ANVIL_LOCAL_BASE_URL → provider auto-resolves to "local".
  const cfgFileRaw = readFileSync(cfgFile, "utf8")
  await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: jsonHdr,
    body: JSON.stringify({ provider: "", model: "", openaiKey: "", anthropicKey: "", hsnrKey: "", thinking: "" }),
  })
  const cfgAutoLocal = await (await fetch(`${base}/api/config`)).json()
  check("local provider auto-detected without API keys", cfgAutoLocal.provider === "local", JSON.stringify(cfgAutoLocal.provider))

  // Explicit provider + empty model → first model of the runtime, thinking off.
  const cfgPutLocal = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: jsonHdr,
    body: JSON.stringify({ provider: "local", model: "", localBaseUrl: "" }),
  })
  check("local config saved (200)", cfgPutLocal.status === 200)
  const cfgLocal = await (await fetch(`${base}/api/config`)).json()
  check("local model auto-picked from the runtime", cfgLocal.model === "mock-llm-1", cfgLocal.model)
  check("local thinking forced off", cfgLocal.thinking === "off", cfgLocal.thinking)

  // A custom base URL from the config file is used.
  const cfgPutLocalBase = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: jsonHdr,
    body: JSON.stringify({ localBaseUrl: mockBase }),
  })
  check("local-base-url saved (200)", cfgPutLocalBase.status === 200)
  delete process.env.ANVIL_LOCAL_BASE_URL
  const lmViaFile = await (await fetch(`${base}/api/local-models`)).json()
  check("local-models: base URL from config file", lmViaFile.ok === true && lmViaFile.baseUrl === mockBase, JSON.stringify(lmViaFile))

  // Without any reachable runtime the settings are saved but not active.
  const cfgPutLocalDead = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: jsonHdr,
    body: JSON.stringify({ provider: "local", localBaseUrl: "http://127.0.0.1:1/v1" }),
  })
  const cfgLocalDead = await cfgPutLocalDead.json()
  check("local saved while runtime is down", cfgLocalDead.ok === true && /not active/.test(cfgLocalDead.note ?? ""), JSON.stringify(cfgLocalDead.note))

  // Restore the pre-section config state.
  writeFileSync(cfgFile, cfgFileRaw, "utf8")
  delete process.env.ANVIL_LOCAL_BASE_URL
  await new Promise<void>((r) => mockHttp.close(() => r()))

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

  // Forking a busy session must be rejected (the history is in flux).
  const forkBusy = await fetch(`${base2}/api/sessions/${id2}/fork`, { method: "POST", headers: jsonHdr, body: JSON.stringify({}) })
  check("fork while busy → 409", forkBusy.status === 409)

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
