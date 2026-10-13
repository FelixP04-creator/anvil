import type { Tool, ToolInput, Todo, ToolContext } from "../types.ts"

function render(todos: Todo[]): string {
  if (todos.length === 0) return "(empty)"
  return todos
    .map((t, i) => {
      const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "
      return `${i + 1}. [${mark}] ${t.content}`
    })
    .join("\n")
}

export function createTodoTool(ctx: ToolContext): Tool {
  return {
    name: "TodoWrite",
    description:
      "Replace the session's todo list. Use it proactively for multi-step work: " +
      "track progress, mark items completed as soon as they are done, keep exactly one item in_progress.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full new todo list (replaces the old one).",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What to do (imperative form)." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    readOnly: true,
    async execute(input: ToolInput) {
      const raw = Array.isArray(input.todos) ? input.todos : null
      if (!raw) return { ok: false, output: "todos must be an array." }
      const next: Todo[] = raw.map((t: any) => ({
        content: String(t?.content ?? ""),
        status: t?.status === "completed" ? "completed" : t?.status === "in_progress" ? "in_progress" : "pending",
      }))
      const inProgress = next.filter((t) => t.status === "in_progress").length
      if (inProgress > 1) {
        return { ok: false, output: "Only one todo may be in_progress at a time. Mark the rest pending." }
      }
      ctx.todos = next
      const remaining = next.filter((t) => t.status !== "completed").length
      return { ok: true, output: `Todo list updated (${next.length} items, ${remaining} remaining):\n${render(next)}` }
    },
  }
}

export { render as renderTodos }
