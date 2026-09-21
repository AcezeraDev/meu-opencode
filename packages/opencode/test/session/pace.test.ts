import { describe, expect, test } from "bun:test"
import { SessionPace } from "../../src/session/pace"

const MIN = 60_000
const run = (model: string, minutes: number, extra: Partial<SessionPace.Run> = {}): SessionPace.Run => ({
  model,
  start: 0,
  end: minutes * MIN,
  steps: 5,
  todos: 0,
  ...extra,
})

describe("how long requests take", () => {
  test("uses the model's own runs, and every model's when it has too few", () => {
    const runs = [run("fast", 1), run("fast", 1), run("fast", 3), run("slow", 10)]
    const fast = SessionPace.summarize({ runs, steps: [], model: "fast" })
    expect(fast.model).toBe("fast")
    expect(fast.runs).toBe(3)
    expect(fast.runMedianMs).toBe(1 * MIN)

    const slow = SessionPace.summarize({ runs, steps: [], model: "slow" })
    expect(slow.model).toBeUndefined()
    expect(slow.runs).toBe(4)
  })

  test("replies without tools and runs left open do not count", () => {
    const runs = [run("m", 1, { steps: 1 }), run("m", 2), run("m", 2), run("m", 2), run("m", 300)]
    const pace = SessionPace.summarize({ runs, steps: [], model: "m" })
    expect(pace.runs).toBe(3)
    expect(pace.runMedianMs).toBe(2 * MIN)
  })

  test("learns the time per todo item from runs that planned", () => {
    const runs = [run("m", 10, { todos: 5 }), run("m", 4, { todos: 2 }), run("m", 1)]
    expect(SessionPace.summarize({ runs, steps: [], model: "m" }).todoMedianMs).toBe(2 * MIN)
  })
})

describe("time left", () => {
  const pace: SessionPace.Pace = { runs: 10, runMedianMs: 2 * MIN, runP75Ms: 5 * MIN, stepMedianMs: 8000, todoMedianMs: MIN }

  test("without a plan, from how long requests usually take", () => {
    expect(SessionPace.estimate({ elapsed: 0 }, pace)).toEqual({ remaining: 2 * MIN, basis: "history" })
    // Past the usual time, the slower runs say how much longer.
    expect(SessionPace.estimate({ elapsed: 3 * MIN }, pace)).toEqual({ remaining: 2 * MIN, basis: "history" })
    // Past nearly all of them, a number would only be a guess.
    expect(SessionPace.estimate({ elapsed: 6 * MIN }, pace)).toBeUndefined()
    expect(SessionPace.estimate({ elapsed: 0 }, undefined)).toBeUndefined()
  })

  test("with a plan, from the pace the agent keeps on it", () => {
    // 2 done and 1 under way in 2.5 minutes: a minute each, 2.5 left.
    const live = SessionPace.estimate({ elapsed: 2.5 * MIN, todos: { total: 5, done: 2, active: 1 } }, pace)
    expect(live).toEqual({ remaining: 2.5 * MIN, basis: "plan" })
    // Before the first is done, from past runs.
    const early = SessionPace.estimate({ elapsed: 1000, todos: { total: 4, done: 0, active: 0 } }, pace)
    expect(early).toEqual({ remaining: 4 * MIN, basis: "plan" })
    // All done is nothing left.
    expect(SessionPace.estimate({ elapsed: MIN, todos: { total: 3, done: 3, active: 0 } }, pace)?.remaining).toBe(0)
  })
})
