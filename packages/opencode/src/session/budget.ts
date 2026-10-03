import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * How much one request may do before the agent has to stop: steps, time, tool
 * calls failing in a row, and calls of any single tool. Decided by software,
 * not by asking the model to stop: once a limit is reached the next step runs
 * with tools switched off, and the model can only summarize.
 *
 * The defaults are generous on purpose. Long, unattended runs (thirty school
 * activities in a row, a whole site built and tested) are the normal use; the
 * limits are there for a model that keeps failing or repeating itself.
 */

export interface Limits {
  steps: number
  minutes: number
  errors: number
  perTool: number
}

export const DEFAULTS: Limits = { steps: 400, minutes: 180, errors: 8, perTool: 300 }

/** 0 in the config means "no limit". */
export function limits(cfg: ConfigV1.Info, agentSteps?: number): Limits {
  const pick = (value: number | undefined, fallback: number) =>
    value === undefined ? fallback : value === 0 ? Infinity : value
  const steps = pick(cfg.limits?.max_steps, DEFAULTS.steps)
  return {
    steps: agentSteps === undefined ? steps : Math.min(steps, agentSteps),
    minutes: pick(cfg.limits?.max_minutes, DEFAULTS.minutes),
    errors: pick(cfg.limits?.max_consecutive_errors, DEFAULTS.errors),
    perTool: pick(cfg.limits?.max_calls_per_tool, DEFAULTS.perTool),
  }
}

/** The tool calls of the current request, oldest first: everything after the last real user message. */
export function toolCalls(messages: SessionV1.WithParts[]) {
  const start = messages.findLastIndex(
    (msg) => msg.info.role === "user" && !msg.parts.every((part) => "synthetic" in part && part.synthetic),
  )
  return messages
    .slice(start + 1)
    .filter((msg) => msg.info.role === "assistant")
    .flatMap((msg) => msg.parts)
    .filter((part): part is SessionV1.ToolPart => part.type === "tool")
}

export interface Check {
  step: number
  startedAt: number
  now: number
  messages: SessionV1.WithParts[]
  limits: Limits
}

/** Why the request has to stop now, in Portuguese, or undefined while it may go on. */
export function exceeded(input: Check): string | undefined {
  const { limits } = input
  if (input.step >= limits.steps) return `limite de ${limits.steps} passos atingido`
  const minutes = (input.now - input.startedAt) / 60_000
  if (minutes >= limits.minutes) return `limite de ${limits.minutes} minutos atingido`
  const calls = toolCalls(input.messages)
  const finished = calls.filter((call) => call.state.status === "completed" || call.state.status === "error")
  // A call to a tool that does not exist is answered by the "invalid" tool,
  // which completes with the error text: it failed all the same.
  const failed = (call: SessionV1.ToolPart) => call.state.status === "error" || call.tool === "invalid"
  const failing = finished.length - 1 - finished.findLastIndex((call) => !failed(call))
  if (failing >= limits.errors) return `${failing} ferramentas falharam seguidas`
  const counts = new Map<string, number>()
  calls.forEach((call) => counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1))
  const worst = [...counts.entries()].find(([, count]) => count >= limits.perTool)
  if (worst) return `a ferramenta ${worst[0]} foi usada ${worst[1]} vezes`
  return undefined
}

export * as SessionBudget from "./budget"
