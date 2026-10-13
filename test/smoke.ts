// Smoke test: runs the full agent loop against a scripted mock provider.
// No API key or network needed. Run with: node test/smoke.ts

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "../src/agent.ts"
import { PermissionEngine } from "../src/permissions.ts"
import { buildSystemPrompt, detectEnv } from "../src/prompt.ts"
import { createMainTools, createSubagentTools } from "../src/tools/index.ts"
import type { Provider, ProviderRequest, ProviderResponse, Tool, ToolContext, ToolInput } from "../src/types.ts"

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

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls++
    this.lastReq = req
    return this.script.shift() ?? { text: "DONE", toolUse: [], stop: "end_turn" }
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

  console.log("— agent loop (mock provider) —")
  const result = await runAgent(
    { provider, model: "mock-model", system, tools, permissions: engine, context: ctx, maxTurns: 10 },
    "make hello.txt say hello world",
  )

  check("final text returned", result.text.includes("Verified"), result.text)
  check("provider called 6 times", provider.calls === 6, `got ${provider.calls}`)
  const fileContent = await readFile(join(dir, "hello.txt"), "utf8")
  check("Write+Edit roundtrip", fileContent === "hello world", JSON.stringify(fileContent))
  check("permissions asked exactly 3x (Write, Bash, Edit)", asks.length === 3, `asks=${asks.length}`)
  check("request carried system prompt", provider.lastReq?.system.includes("# Environment") ?? false)
  check("request carried tool schemas", (provider.lastReq?.tools.length ?? 0) === 8, `tools=${provider.lastReq?.tools.length}`)

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

  console.log("\n— system prompt —")
  check("prompt contains environment", system.includes(`Working directory: ${dir}`))
  check("prompt contains safety section", system.includes("# Security"))
  check("prompt contains tone rules", system.includes("Be concise"))

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
