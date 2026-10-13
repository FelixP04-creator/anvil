// Interactive terminal loop: streamed output + permission prompts.

import * as readline from "node:readline/promises"
import { runAgent, type AgentEvent, type AgentOptions } from "./agent.ts"
import { PermissionEngine, type AskFn, type PermissionMode, formatCall } from "./permissions.ts"
import type { Message, ToolContext } from "./types.ts"
import { renderTodos } from "./tools/todo.ts"

export interface ReplDeps {
  makeOptions: (engine: PermissionEngine) => AgentOptions
  ctx: ToolContext
  mode: PermissionMode
}

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"]

export async function startRepl(deps: ReplDeps): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  const ask: AskFn = async (_tool, _input, detail) => {
    const answer = (await rl.question(`permission  ${detail}  [y / a(lways) / d]enied: `)).trim().toLowerCase()
    if (answer === "a" || answer === "always") return "always"
    if (answer === "" || answer === "y" || answer === "yes") return "once"
    return "deny"
  }
  const engine = new PermissionEngine(deps.mode, ask, true)

  // Conversation history persists across turns so the agent remembers context.
  const history: Message[] = []

  console.log("anvil — interactive mode. /help for commands, Ctrl+D or /exit to quit.")

  while (true) {
    let line: string
    try {
      line = (await rl.question("you> ")).trim()
    } catch {
      break // Ctrl+D
    }
    if (!line) continue

    if (line === "/exit" || line === "/quit") break
    if (line === "/help") {
      console.log(
        [
          "/help                          this list",
          "/mode <mode>                   default | acceptEdits | plan | bypass",
          "/todos                         show the todo list",
          "/exit                          quit",
        ].join("\n"),
      )
      continue
    }
    if (line.startsWith("/mode")) {
      const next = line.split(/\s+/)[1] as PermissionMode | undefined
      if (!next || !MODES.includes(next)) {
        console.log("usage: /mode <default | acceptEdits | plan | bypass>")
        continue
      }
      engine.mode = next
      console.log(`mode: ${next}`)
      continue
    }
    if (line === "/todos") {
      console.log(renderTodos(deps.ctx.todos))
      continue
    }
    if (line.startsWith("/")) {
      console.log(`unknown command: ${line} (try /help)`)
      continue
    }

    history.push({ role: "user", content: [{ type: "text", text: line }] })

    const base = deps.makeOptions(engine)
    let streaming = false
    const onEvent = (e: AgentEvent) => {
      if (e.type === "assistant_delta") {
        if (!streaming) {
          process.stdout.write("\nanvil> ")
          streaming = true
        }
        process.stdout.write(e.text ?? "")
      } else if (e.type === "assistant_text") {
        if (streaming) process.stdout.write("\n")
        else console.log(`\nanvil> ${e.text}\n`)
        streaming = false
      } else if (e.type === "tool_start") {
        console.log(`  [tool] ${formatCall(e.toolName ?? "", e.input)}`)
      } else if (e.type === "denied") {
        console.log(`  [denied] ${e.toolName}: ${e.text}`)
      } else if (e.type === "error") {
        console.error(`  [error] ${e.text}`)
      }
    }

    try {
      await runAgent({ ...base, onEvent }, history)
    } catch (err) {
      console.error(`error: ${String(err)}`)
    }
  }

  rl.close()
  console.log("bye")
}
