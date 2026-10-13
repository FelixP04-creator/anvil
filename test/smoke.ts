// Smoke test: runs the full agent loop against a scripted mock provider.
// No API key or network needed. Run with: node test/smoke.ts

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent, type AgentEvent } from "../src/agent.ts"
import { PermissionEngine } from "../src/permissions.ts"
import { buildSystemPrompt, detectEnv } from "../src/prompt.ts"
import { loadMemory } from "../src/memory.ts"
import { createMainTools, createSubagentTools } from "../src/tools/index.ts"
import { OpenAIProvider } from "../src/providers/openai.ts"
import { createServer } from "node:http"
import type { Message, Provider, ProviderRequest, ProviderResponse, Tool, ToolContext, ToolInput } from "../src/types.ts"

let failures = 0
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`)
  }
}

class MockProvider implements Provider {
  name = "mock"
  calls = 0
  lastReq: ProviderRequest | null = null
  script: ProviderResponse[]

  constructor(script: ProviderResponse[]) {
    this.script = script
  }

  async complete(
    req: ProviderRequest,
    onDelta: (t: string) => void,
    _signal?: AbortSignal,
    onThinking?: (t: string) => void,
  ): Promise<ProviderResponse> {
    this.calls++
    this.lastReq = req
    const resp = this.script.shift() ?? { text: "DONE", toolUse: [], stop: "end_turn" }
    // Simulate streaming: emit thinking and text in small chunks.
    if (resp.thinking) {
      for (let i = 0; i < resp.thinking.length; i += 16) onThinking?.(resp.thinking.slice(i, i + 16))
    }
    if (resp.text) {
      for (let i = 0; i < resp.text.length; i += 12) onDelta(resp.text.slice(i, i + 12))
    }
    return resp
  }
}

/** Fails with a transient error `failsLeft` times, then succeeds. */
class FlakyProvider implements Provider {
  name = "flaky"
  calls = 0
  failsLeft: number

  constructor(failsLeft = 2) {
    this.failsLeft = failsLeft
  }

  async complete(
    _req: ProviderRequest,
    onDelta: (t: string) => void,
  ): Promise<ProviderResponse> {
    this.calls++
    if (this.failsLeft > 0) {
      this.failsLeft--
      throw new Error("API error 429: overloaded")
    }
    onDelta("recovered")
    return { text: "recovered", toolUse: [], stop: "end_turn" }
  }
}

const tu = (id: string, name: string, input: ToolInput) => ({ id, name, input })

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "anvil-test-"))
  console.log(`workdir: ${dir}\n`)

  const env = detectEnv(dir)
  const ctx: ToolContext = { cwd: dir, todos: [] }
  const system = buildSystemPrompt(env)

  const provider = new MockProvider([
    { text: "", toolUse: [tu("1", "Write", { file_path: join(dir, "hello.txt"), content: "hi" })], stop: "tool_use" },
    { text: "", toolUse: [tu("2", "Bash", { command: "echo smoke-ok" })], stop: "tool_use" },
    { text: "", toolUse: [tu("3", "Edit", { file_path: join(dir, "hello.txt"), old_string: "hi", new_string: "hello world" })], stop: "tool_use" },
    { text: "", toolUse: [tu("4", "Glob", { pattern: "**/*.txt" })], stop: "tool_use" },
    { text: "", toolUse: [tu("5", "Grep", { pattern: "hello world" })], stop: "tool_use" },
    { text: "Verified: wrote, edited, and confirmed hello.txt via glob and grep.", toolUse: [], stop: "end_turn" },
  ])

  const subagentTools = createSubagentTools()
  const asks: string[] = []
  const engine = new PermissionEngine("default", async (_t, _i, detail) => {
    asks.push(detail)
    return "once"
  }, true)

  const tools = createMainTools(ctx, {
    provider,
    model: "mock-model",
    subagentSystem: "subagent system prompt",
    subagentTools,
    check: (t: Tool, i: ToolInput) => engine.check(t, i),
    maxTurns: 30,
  })

  const opts = {
    provider,
    model: "mock-model",
    system,
    tools,
    permissions: engine,
    context: ctx,
    maxTurns: 10,
  }

  console.log("— agent loop (mock provider) —")
  const events: AgentEvent[] = []
  const history = [{ role: "user", content: [{ type: "text", text: "make hello.txt say hello world" }] }]
  const result = await runAgent({ ...opts, onEvent: (e) => events.push(e) }, history)

  check("final text returned", result.text.includes("Verified"), result.text)
  check("provider called 6 times", provider.calls === 6, `got ${provider.calls}`)
  const fileContent = await readFile(join(dir, "hello.txt"), "utf8")
  check("Write+Edit roundtrip", fileContent === "hello world", JSON.stringify(fileContent))
  check("permissions asked exactly 3x (Write, Bash, Edit)", asks.length === 3, `asks=${asks.length}`)
  check("request carried system prompt", provider.lastReq?.system.includes("# Environment") ?? false)
  check("request carried tool schemas", (provider.lastReq?.tools.length ?? 0) === 8, `tools=${provider.lastReq?.tools.length}`)

  console.log("\n— streaming —")
  const deltas = events.filter((e) => e.type === "assistant_delta")
  check("assistant deltas emitted", deltas.length > 0)
  check("deltas reconstruct final text", deltas.map((d) => d.text).join("").includes("Verified"))
  check("assistant_text event emitted", events.some((e) => e.type === "assistant_text"))

  console.log("\n— multi-turn history —")
  check("history accumulated", history.length >= 11, `len=${history.length}`)
  provider.script.push({ text: "Still here. The file says: hello world", toolUse: [], stop: "end_turn" })
  history.push({ role: "user", content: [{ type: "text", text: "what does the file say?" }] })
  const result2 = await runAgent({ ...opts, onEvent: () => {} }, history)
  check("second turn works", result2.text.includes("Still here"))
  check("provider saw prior turns", (provider.lastReq?.messages.length ?? 0) >= 12, `msgs=${provider.lastReq?.messages.length}`)

  console.log("\n— thinking —")
  const thinkProvider = new MockProvider([
    {
      thinking: "Let me check the layout first, then answer.",
      thinkingSignature: "sig-123",
      text: "",
      toolUse: [tu("t1", "Glob", { pattern: "**/*" })],
      stop: "tool_use",
    },
    { text: "Done thinking, done globbing.", toolUse: [], stop: "end_turn" },
  ])
  const tEvents: AgentEvent[] = []
  const tHistory: Message[] = [{ role: "user", content: [{ type: "text", text: "what files are here?" }] }]
  const tResult = await runAgent(
    { ...opts, provider: thinkProvider, thinking: "medium", onEvent: (e) => tEvents.push(e) },
    tHistory,
  )
  check("thinking deltas emitted", tEvents.filter((e) => e.type === "thinking_delta").length > 0)
  const thoughtBlock = tHistory
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content)
    .find((b) => b.type === "thinking")
  check(
    "thinking block stored in history",
    Boolean(thoughtBlock && thoughtBlock.type === "thinking" && thoughtBlock.text.includes("layout")),
  )
  check(
    "thinking signature preserved",
    thoughtBlock?.type === "thinking" && thoughtBlock.signature === "sig-123",
  )
  check("thinking effort passed to provider", thinkProvider.lastReq?.thinking === "medium")
  check("answer returned after thinking", tResult.text.includes("Done thinking"))

  console.log("\n— max-tokens continuation —")
  const contProvider = new MockProvider([
    { text: "The answer starts here and is", toolUse: [], stop: "max_tokens" },
    { text: " cut off, so I continue.", toolUse: [], stop: "end_turn" },
  ])
  const contHistory: Message[] = [{ role: "user", content: [{ type: "text", text: "tell me something long" }] }]
  const cResult = await runAgent({ ...opts, provider: contProvider, onEvent: () => {} }, contHistory)
  check("continuation triggered (2 completions)", contProvider.calls === 2, `calls=${contProvider.calls}`)
  check(
    "final text includes both parts",
    cResult.text.includes("starts here") && cResult.text.includes("I continue"),
    cResult.text,
  )
  check(
    "continuation nudge appended to history",
    contHistory.some(
      (m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text.includes("Continue exactly where")),
    ),
  )

  console.log("\n— retry with backoff —")
  const flaky = new FlakyProvider(2)
  const rEvents: AgentEvent[] = []
  const rHistory: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
  const rResult = await runAgent(
    { ...opts, provider: flaky, retryBaseDelayMs: 10, onEvent: (e) => rEvents.push(e) },
    rHistory,
  )
  check("recovered after transient failures", rResult.text.includes("recovered"))
  check("provider attempted 3 times", flaky.calls === 3, `calls=${flaky.calls}`)
  check("retry events emitted", rEvents.filter((e) => e.type === "retry").length === 2)

  console.log("\n— truncated & malformed tool calls —")
  // Provider reports a truncation inside a tool call as max_tokens with no
  // tool use: the agent nudges and the model gets another shot.
  const truncProvider = new MockProvider([
    { text: "", thinking: "long thinking that ate the budget", toolUse: [], stop: "max_tokens" },
    { text: "", toolUse: [tu("u1", "Glob", { pattern: "**/*" })], stop: "tool_use" },
    { text: "Recovered after truncation.", toolUse: [], stop: "end_turn" },
  ])
  const truncHistory: Message[] = [{ role: "user", content: [{ type: "text", text: "list the files" }] }]
  const truncResult = await runAgent({ ...opts, provider: truncProvider, onEvent: () => {} }, truncHistory)
  check("truncated tool call gets a continuation (3 completions)", truncProvider.calls === 3, `calls=${truncProvider.calls}`)
  check("truncation recovered", truncResult.text.includes("Recovered after truncation"), truncResult.text)
  check(
    "nudge appended after truncated tool call",
    truncHistory.some(
      (m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text.includes("Continue exactly where")),
    ),
  )

  // Malformed tool-call JSON after streamed output: retried despite output.
  class MalformedToolJsonProvider implements Provider {
    name = "malformed"
    calls = 0
    async complete(_req: ProviderRequest, onDelta: (t: string) => void): Promise<ProviderResponse> {
      this.calls++
      onDelta("partial output")
      if (this.calls === 1) {
        throw new Error('Malformed tool call JSON from model (Write): Unterminated string in JSON — raw arguments: {"file_path":')
      }
      return { text: "recovered from malformed tool json", toolUse: [], stop: "end_turn" }
    }
  }
  const malformed = new MalformedToolJsonProvider()
  const mEvents: AgentEvent[] = []
  const mHistory: Message[] = [{ role: "user", content: [{ type: "text", text: "write a file" }] }]
  const mResult = await runAgent(
    { ...opts, provider: malformed, retryBaseDelayMs: 10, onEvent: (e) => mEvents.push(e) },
    mHistory,
  )
  check("malformed tool json retried despite streamed output", malformed.calls === 2, `calls=${malformed.calls}`)
  check("malformed tool json recovered", mResult.text.includes("recovered from malformed"), mResult.text)
  check("malformed tool json retry event emitted", mEvents.some((e) => e.type === "retry"))

  console.log("\n— openai provider (fake SSE endpoint) —")
  let capturedBody: Record<string, unknown> = {}
  let nextSse = ""
  const sse = (lines: string[]) => lines.map((l) => `data: ${l}\n\n`).join("")
  // Tool-call SSE deltas built with JSON.stringify so the nested argument
  // escaping can't go wrong (hand-escaped strings are a trap).
  function tc(args: string, finish: string | null, name?: string): string {
    const fn: Record<string, unknown> = { arguments: args }
    if (name) fn.name = name
    return JSON.stringify({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: "c1", function: fn }] },
          finish_reason: finish,
        },
      ],
    })
  }
  const sseServer = createServer((req, res) => {
    let data = ""
    req.on("data", (c) => (data += c))
    req.on("end", () => {
      capturedBody = JSON.parse(data)
      res.writeHead(200, { "content-type": "text/event-stream", connection: "close" })
      res.write(nextSse)
      res.end()
    })
  })
  await new Promise<void>((r) => sseServer.listen(0, "127.0.0.1", r))
  const ssePort = (sseServer.address() as { port: number }).port
  const oa = new OpenAIProvider("test-key", `http://127.0.0.1:${ssePort}/openai`, true)
  const oaReq: ProviderRequest = {
    model: "Qwen/Qwen3.8-27B",
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxTokens: 8000,
  }

  // thinking high must reserve a completion budget that survives the
  // thinking block (budget + margin), or tool calls get truncated mid-JSON.
  oaReq.thinking = "high"
  nextSse = sse([
    '{"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "[DONE]",
  ])
  const oaHigh = await oa.complete(oaReq, () => {})
  check(
    "thinking high raises max_completion_tokens to budget+margin",
    capturedBody.max_completion_tokens === 36864,
    String(capturedBody.max_completion_tokens),
  )
  check("reasoning effort high sent", capturedBody.reasoning_effort === "high")
  check("plain text answer parsed", oaHigh.text === "ok" && oaHigh.stop === "end_turn")

  // thinking off keeps the base budget and sends no reasoning_effort
  oaReq.thinking = "off"
  nextSse = sse([
    '{"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "[DONE]",
  ])
  await oa.complete(oaReq, () => {})
  check("thinking off keeps base max_completion_tokens", capturedBody.max_completion_tokens === 8000)
  check("thinking off sends no reasoning_effort", !("reasoning_effort" in capturedBody))

  // a tool call truncated by the token limit → max_tokens, no tool use
  // (accumulated arguments: {"file_path": "a.txt",  — unterminated)
  nextSse = sse([
    tc('{"file_path": ', null, "Write"),
    tc('"a.txt", ', null),
    '{"choices":[{"delta":{},"finish_reason":"length"}]}',
    "[DONE]",
  ])
  const oaTrunc = await oa.complete(oaReq, () => {})
  check("truncated tool call reported as max_tokens", oaTrunc.stop === "max_tokens", oaTrunc.stop)
  check("truncated tool call dropped", oaTrunc.toolUse.length === 0)

  // invalid JSON without truncation → descriptive error (retryable upstream)
  nextSse = sse([
    tc('{"file_path": "a.txt", "content": "bad', "tool_calls", "Write"),
    "[DONE]",
  ])
  let oaErr: unknown = null
  try {
    await oa.complete(oaReq, () => {})
  } catch (err) {
    oaErr = err
  }
  check(
    "malformed tool json throws descriptive error",
    oaErr !== null && /Malformed tool call JSON/.test(String(oaErr)),
    String(oaErr),
  )

  // a valid tool call still parses
  nextSse = sse([
    tc('{"file_path": "a.txt"}', null, "Write"),
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    "[DONE]",
  ])
  const oaTool = await oa.complete(oaReq, () => {})
  check(
    "valid tool call parsed",
    oaTool.toolUse.length === 1 &&
      oaTool.toolUse[0].name === "Write" &&
      (oaTool.toolUse[0].input as Record<string, unknown>).file_path === "a.txt",
    JSON.stringify(oaTool.toolUse),
  )
  check("tool call stop reason", oaTool.stop === "tool_use")
  // Close the server fully before the process exits: on Windows, exiting
  // while the client's keep-alive socket is still closing trips a libuv
  // assertion. "connection: close" (above) plus the drain below make the
  // teardown deterministic.
  await new Promise<void>((r, j) => {
    sseServer.close((err) => (err ? j(err) : r()))
    sseServer.closeAllConnections()
  })
  await new Promise((r) => setTimeout(r, 100))


  console.log("\n— permission modes —")
  const writeTool = tools.find((t) => t.name === "Write")!
  const readTool = tools.find((t) => t.name === "Read")!

  const planEngine = new PermissionEngine("plan", async () => "once", true)
  check("plan mode denies Write", !(await planEngine.check(writeTool, { file_path: "x", content: "y" })).allowed)
  check("plan mode allows Read", (await planEngine.check(readTool, { file_path: "x" })).allowed)

  const niEngine = new PermissionEngine("default", async () => "once", false)
  check("non-interactive default mode denies Write", !(await niEngine.check(writeTool, { file_path: "x", content: "y" })).allowed)

  const aeEngine = new PermissionEngine("acceptEdits", async () => "deny", false)
  check("acceptEdits mode allows Write", (await aeEngine.check(writeTool, { file_path: "x", content: "y" })).allowed)
  check("acceptEdits mode denies Bash", !(await aeEngine.check(tools.find((t) => t.name === "Bash")!, { command: "rm -rf /" })).allowed)

  const bEngine = new PermissionEngine("bypass", async () => "deny", false)
  check("bypass mode allows Bash", (await bEngine.check(tools.find((t) => t.name === "Bash")!, { command: "ls" })).allowed)

  console.log("\n— system prompt & memory —")
  check("prompt contains environment", system.includes(`Working directory: ${dir}`))
  check("prompt contains safety section", system.includes("# Security"))
  check("prompt contains tone rules", system.includes("Be concise"))
  check("no memory → no instructions section", !system.includes("# Project and user instructions"))

  await writeFile(join(dir, "ANVIL.md"), "Always run the test suite before declaring work finished.")
  const memPrompt = buildSystemPrompt(env, loadMemory(dir))
  check("ANVIL.md loaded into prompt", memPrompt.includes("Always run the test suite"))
  check("memory section header present", memPrompt.includes("# Project and user instructions"))

  console.log("\n— tools in isolation —")
  const globResult = await tools.find((t) => t.name === "Glob")!.execute({ pattern: "**/*.txt" }, ctx)
  check("Glob finds hello.txt", globResult.ok && globResult.output.includes("hello.txt"), globResult.output)

  const grepResult = await tools.find((t) => t.name === "Grep")!.execute({ pattern: "hello world" }, ctx)
  check("Grep finds content", grepResult.ok && grepResult.output.includes("hello.txt:1:"), grepResult.output)

  const todoTool = tools.find((t) => t.name === "TodoWrite")!
  const todoResult = await todoTool.execute(
    { todos: [{ content: "step one", status: "completed" }, { content: "step two", status: "in_progress" }] },
    ctx,
  )
  check("TodoWrite stores list", todoResult.ok && ctx.todos.length === 2, todoResult.output)
  const badTodo = await todoTool.execute(
    {
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    },
    ctx,
  )
  check("TodoWrite rejects two in_progress items", !badTodo.ok)

  await rm(dir, { recursive: true, force: true })
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
