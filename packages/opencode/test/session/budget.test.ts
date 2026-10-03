import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionBudget } from "@/session/budget"

const user = (synthetic = false) =>
  ({ info: { role: "user" }, parts: [{ type: "text", text: "oi", synthetic }] }) as unknown as SessionV1.WithParts
const assistant = (...calls: { tool: string; status: "completed" | "error" | "running" }[]) =>
  ({
    info: { role: "assistant" },
    parts: calls.map((call) => ({ type: "tool", tool: call.tool, state: { status: call.status } })),
  }) as unknown as SessionV1.WithParts

const limits = SessionBudget.limits({} as ConfigV1.Info)
const check = (messages: SessionV1.WithParts[], patch: Partial<SessionBudget.Check> = {}) =>
  SessionBudget.exceeded({ step: 1, startedAt: 0, now: 1000, messages, limits, ...patch })

describe("session budget", () => {
  test("generous defaults, 0 means no limit, and an agent's own steps still count", () => {
    expect(limits).toEqual(SessionBudget.DEFAULTS)
    const none = SessionBudget.limits({ limits: { max_steps: 0, max_minutes: 0 } } as ConfigV1.Info)
    expect(none.steps).toBe(Infinity)
    expect(none.minutes).toBe(Infinity)
    expect(SessionBudget.limits({} as ConfigV1.Info, 10).steps).toBe(10)
  })

  test("a normal request goes on", () => {
    expect(check([user(), assistant({ tool: "read", status: "completed" }, { tool: "bash", status: "error" })])).toBeUndefined()
  })

  test("steps and time", () => {
    expect(check([user()], { step: 400 })).toContain("400 passos")
    expect(check([user()], { now: 180 * 60_000 })).toContain("180 minutos")
  })

  test("only failures in a row count; one success resets them", () => {
    const fail = { tool: "bash", status: "error" } as const
    const ok = { tool: "bash", status: "completed" } as const
    expect(check([user(), assistant(fail, fail, fail, fail, fail, fail, fail, ok)])).toBeUndefined()
    expect(check([user(), assistant(fail, fail, fail, fail), assistant(fail, fail, fail, fail)])).toContain("8 ferramentas")
    // A call to a tool that does not exist completes as "invalid": still a failure.
    const invalid = { tool: "invalid", status: "completed" } as const
    expect(check([user(), assistant(...Array(8).fill(invalid))])).toContain("8 ferramentas")
  })

  test("one tool used too many times", () => {
    const read = { tool: "read", status: "completed" } as const
    expect(check([user(), assistant(...Array(300).fill(read))])).toContain("read foi usada 300 vezes")
  })

  test("a new request from the person starts counting again; automatic messages do not", () => {
    const fail = { tool: "bash", status: "error" } as const
    const eight = assistant(...Array(8).fill(fail))
    expect(check([user(), eight, user()])).toBeUndefined()
    expect(check([user(), eight, user(true)])).toContain("8 ferramentas")
  })
})
