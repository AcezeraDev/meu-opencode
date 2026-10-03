import { describe, expect, test } from "bun:test"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ModelRoles } from "@/provider/roles"

const cfg = (value: Partial<ConfigV1.Info>) => value as ConfigV1.Info

describe("model roles", () => {
  test("nothing set: no role has a model", () => {
    for (const role of ["coding", "fast", "reasoning", "vision", "evaluation"] as const)
      expect(ModelRoles.pick(cfg({}), role)).toBeUndefined()
  })

  test("model and small_model keep winning over the roles that mirror them", () => {
    const both = cfg({ model: "anthropic/a", small_model: "ollama/b", models: { coding: "ollama/c", fast: "ollama/d" } })
    expect(ModelRoles.pick(both, "coding")).toBe("anthropic/a")
    expect(ModelRoles.pick(both, "fast")).toBe("ollama/b")
    const roles = cfg({ models: { coding: "ollama/qwen3.5:4b", fast: "ollama/qwen3.5:2b" } })
    expect(ModelRoles.pick(roles, "coding")).toBe("ollama/qwen3.5:4b")
    expect(ModelRoles.pick(roles, "fast")).toBe("ollama/qwen3.5:2b")
  })

  test("evaluation falls back to reasoning, then to the main model; vision has no fallback", () => {
    expect(ModelRoles.pick(cfg({ model: "x/main" }), "evaluation")).toBe("x/main")
    expect(ModelRoles.pick(cfg({ model: "x/main", models: { reasoning: "x/think" } }), "evaluation")).toBe("x/think")
    expect(ModelRoles.pick(cfg({ models: { evaluation: "x/judge", reasoning: "x/think" } }), "evaluation")).toBe("x/judge")
    expect(ModelRoles.pick(cfg({ model: "x/main" }), "vision")).toBeUndefined()
    expect(ModelRoles.pick(cfg({ models: { vision: "ollama/qwen3.5:4b" } }), "vision")).toBe("ollama/qwen3.5:4b")
  })
})
