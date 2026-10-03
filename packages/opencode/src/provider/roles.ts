import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

/**
 * Models by role (`models` in opencode.jsonc). Every role can be a local or an
 * external model, so the brain of each part can change without code changes.
 *
 * - coding: the main model when `model` is not set
 * - fast: titles and summaries when `small_model` is not set
 * - reasoning: the plan agent, unless the agent sets its own
 * - vision: reads screenshots for visual evaluation
 * - evaluation: checks results; falls back to reasoning, then the main model
 * - writing: writes longer texts for the agent to type into pages (no fallback)
 */

export type Role = "coding" | "fast" | "reasoning" | "vision" | "evaluation" | "writing"

const FALLBACK: Record<Role, Role[]> = {
  coding: [],
  fast: [],
  reasoning: ["coding"],
  vision: [],
  evaluation: ["reasoning", "coding"],
  writing: [],
}

/** The configured `provider/model` for a role, following its fallbacks; undefined when none is set. */
export function pick(cfg: ConfigV1.Info, role: Role): string | undefined {
  const own = role === "coding" ? (cfg.model ?? cfg.models?.coding) : role === "fast" ? (cfg.small_model ?? cfg.models?.fast) : cfg.models?.[role]
  if (own) return own
  return FALLBACK[role].map((next) => pick(cfg, next)).find((value) => value !== undefined)
}

export * as ModelRoles from "./roles"
