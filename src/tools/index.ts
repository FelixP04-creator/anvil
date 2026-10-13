// Tool registry: assembles the tool sets for main agent and subagents.

import type { Tool, ToolContext } from "../types.ts"
import { readTool } from "./read.ts"
import { writeTool } from "./write.ts"
import { editTool } from "./edit.ts"
import { bashTool } from "./bash.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { createTodoTool } from "./todo.ts"
import { createTaskTool, type SubagentDeps } from "./task.ts"

export const CORE_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool, globTool, grepTool]

/** Tools available to subagents (no Task, no TodoWrite). */
export function createSubagentTools(): Tool[] {
  return [...CORE_TOOLS]
}

export function createMainTools(ctx: ToolContext, deps: SubagentDeps): Tool[] {
  return [
    ...CORE_TOOLS,
    createTodoTool(ctx),
    createTaskTool(ctx, deps),
  ]
}
