import matter from "gray-matter"
import path from "path"

export const AVAILABLE_AGENT_PERMISSIONS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "websearch",
  "lsp",
  "skill",
  "browser",
] as const

export type AgentPermission = (typeof AVAILABLE_AGENT_PERMISSIONS)[number]

export type AgentFileInput = {
  description?: string
  mode: "all" | "primary" | "subagent"
  model?: { providerID: string; modelID: string }
  variant?: string
  prompt: string
  temperature?: number
  topP?: number
  color?: string
  options?: Readonly<Record<string, unknown>>
  steps?: number
  permissions: readonly AgentPermission[]
}

export type AgentMutationError = "invalid-name" | "native"

export function validateAgentMutation(name: string, agents: Array<{ name: string; native?: boolean }>) {
  if (!/^[a-z0-9-]+$/.test(name)) return "invalid-name" satisfies AgentMutationError
  if (agents.some((agent) => agent.name === name && agent.native === true)) return "native" satisfies AgentMutationError
}

export function agentFilePath(root: string, name: string) {
  const directory = path.resolve(root, "agent")
  const target = path.resolve(directory, `${name}.md`)
  if (!target.startsWith(`${directory}${path.sep}`)) return
  return { directory, target }
}

export function serializeAgent(input: AgentFileInput) {
  const permission = Object.fromEntries(
    AVAILABLE_AGENT_PERMISSIONS.map((item) => [item, input.permissions.includes(item) ? "allow" : "deny"]),
  )
  return matter.stringify(input.prompt, {
    ...(input.description ? { description: input.description } : {}),
    mode: input.mode,
    ...(input.model ? { model: `${input.model.providerID}/${input.model.modelID}` } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.color ? { color: input.color } : {}),
    ...(input.options && Object.keys(input.options).length ? { options: input.options } : {}),
    ...(input.steps !== undefined ? { steps: input.steps } : {}),
    permission,
  })
}
