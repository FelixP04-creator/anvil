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
  /** Preloaded history (resume). */
  history?: Message[]
  /** Stable session id, printed so the user can resume later. */
  sessionId?: string
  /** Called after each finished turn (session persistence hook). */
  onTurn?: (history: Message[], usage: { input: number; output: number }) => void
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
  const history: Message[] = [...(deps.history ?? [])]

  console.log("anvil — interactive mode. /help for commands, Ctrl+D or /exit to quit.")
  if (deps.sessionId) {
    console.log(`session: ${deps.sessionId} — resume later with: anvil -r ${deps.sessionId}`)
  }
  if (history.length > 0) {
    console.log(`resumed ${history.length} saved messages`)
  }

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
    let thinking = false
    const onEvent = (e: AgentEvent) => {
      if (e.type === "thinking_delta") {
        if (!thinking) {
          thinking = true
          process.stdout.write("\n  thinking…\n")
        }
      } else if (e.type === "assistant_delta") {
        if (!streaming) {
          if (thinking) {
            process.stdout.write("\n")
            thinking = false
          }
          process.stdout.write("anvil> ")
          streaming = true
        }
        process.stdout.write(e.text ?? "")
      } else if (e.type === "assistant_text") {
        if (thinking || streaming) process.stdout.write("\n")
        else console.log(`\nanvil> ${e.text}\n`)
        thinking = false
        streaming = false
      } else if (e.type === "tool_start") {
        console.log(`  [tool] ${formatCall(e.toolName ?? "", e.input)}`)
      } else if (e.type === "denied") {
        console.log(`  [denied] ${e.toolName}: ${e.text}`)
      } else if (e.type === "retry") {
        console.error(`  [retry] ${e.text}`)
      } else if (e.type === "error") {
        console.error(`  [error] ${e.text}`)
      }
    }

    try {
      const result = await runAgent({ ...base, onEvent }, history)
      try {
        deps.onTurn?.(history, result.usage)
      } catch {
        // persistence is best-effort
      }
    } catch (err) {
      console.error(`error: ${String(err)}`)
    }
  }

  rl.close()
  console.log("bye")
}
