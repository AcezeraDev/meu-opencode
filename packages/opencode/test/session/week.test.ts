import { describe, expect, test } from "bun:test"
import { SessionWeek } from "../../src/session/week"

const reply = (id: string, sessionID: string, modelID: string, cost: number, ms: number) => ({
  id,
  sessionID,
  providerID: "nano-gpt",
  modelID,
  cost,
  created: 1_000,
  completed: 1_000 + ms,
})

const call = (messageID: string, tool: string, status: string, ms: number, error: string | null = null) => ({
  sessionID: "s1",
  messageID,
  tool,
  status,
  error,
  start: 5_000,
  end: 5_000 + ms,
})

describe("weekly summary", () => {
  test("splits time between the model and the tools, and adds up spend", () => {
    const week = SessionWeek.summarize({
      since: 0,
      messages: [reply("m1", "s1", "ling", 0.01, 10_000), reply("m2", "s1", "ling", 0.02, 6_000)],
      tools: [call("m1", "browser_act", "completed", 4_000), call("m2", "read", "completed", 1_000)],
      sessions: [{ id: "s1", title: "Lições de banco de dados", parentID: null }],
      notebook: 3,
    })
    expect(week.sessions).toBe(1)
    expect(week.steps).toBe(2)
    expect(week.cost).toBeCloseTo(0.03)
    expect(week.toolMs).toBe(5_000)
    expect(week.browserMs).toBe(4_000)
    expect(week.modelMs).toBe(11_000)
    expect(week.browserActions).toBe(1)
    expect(week.notebook).toBe(3)
    expect(week.topSessions).toEqual([{ id: "s1", title: "Lições de banco de dados", steps: 2, cost: 0.03 }])
  })

  test("names the model that erred least, among those used enough to tell", () => {
    const messages = [reply("a", "s1", "ling", 0, 1), reply("b", "s1", "mimo", 0, 1), reply("c", "s1", "rare", 0, 1)]
    const tools = [
      ...Array.from({ length: 20 }, (_, index) => call("a", "browser_act", index < 4 ? "error" : "completed", 1)),
      ...Array.from({ length: 25 }, (_, index) => call("b", "browser_act", index < 1 ? "error" : "completed", 1)),
      // Never wrong, but three calls say nothing.
      ...Array.from({ length: 3 }, () => call("c", "browser_act", "completed", 1)),
    ]
    const week = SessionWeek.summarize({ since: 0, messages, tools, sessions: [], notebook: 0 })
    expect(week.reliable).toEqual({ model: "nano-gpt/mimo", tools: 25, errors: 1 })
  })

  test("groups repeated errors even when their numbers differ", () => {
    const week = SessionWeek.summarize({
      since: 0,
      messages: [reply("m1", "s1", "ling", 0, 1)],
      tools: [
        call("m1", "browser_act", "error", 1, "No element matches ref_12 on the page"),
        call("m1", "browser_act", "error", 1, "No element matches ref_40 on the page"),
        call("m1", "browser_navigate", "error", 1, "did not answer within 30s"),
      ],
      sessions: [],
      notebook: 0,
    })
    expect(week.topErrors[0]).toEqual({ message: "browser_act: No element matches ref_N on the page", count: 2 })
  })

  test("a subagent's session counts toward the task that started it, not as a session of its own", () => {
    const week = SessionWeek.summarize({
      since: 0,
      messages: [reply("m1", "root", "ling", 0, 1), reply("m2", "child", "ling", 0, 1)],
      tools: [],
      sessions: [
        { id: "root", title: "Tarefa", parentID: null },
        { id: "child", title: "Explorar", parentID: "root" },
      ],
      notebook: 0,
    })
    expect(week.sessions).toBe(1)
  })
})
