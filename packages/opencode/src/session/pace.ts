/**
 * How long work usually takes, learned from the person's own history.
 *
 * A request's duration depends far more on the model and on how the person
 * works than on anything a formula could guess, so the estimate shown while
 * the agent works starts from what past requests actually took: whole runs,
 * single steps, and each item of the agent's todo list.
 */

/** One request and everything the agent did for it. */
export interface Run {
  model: string
  start: number
  end: number
  /** Assistant messages, one per round of model output and tool calls. */
  steps: number
  /** The longest todo list the agent wrote during the run, if any. */
  todos: number
}

export interface Pace {
  /** How many past runs the figures come from. */
  runs: number
  /** The model the figures are for; absent when too few runs forced using every model. */
  model?: string
  runMedianMs?: number
  runP75Ms?: number
  stepMedianMs?: number
  /** Time per todo item, over runs that planned with a todo list. */
  todoMedianMs?: number
}

/** A reply without tools says nothing about how long work takes. */
const MIN_STEPS = 2
/** Below this many runs for a model, every model's runs are used instead. */
const MIN_RUNS = 3
/** Longer than this is a run left open or a person away, not work. */
const MAX_RUN_MS = 2 * 60 * 60 * 1000

function quantile(values: number[], q: number) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return Math.round(sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low))
}

/** Sums up past runs, preferring those made with `model`. */
export function summarize(input: { runs: Run[]; steps: { model: string; ms: number }[]; model?: string }): Pace {
  const work = input.runs.filter(
    (run) => run.steps >= MIN_STEPS && run.end > run.start && run.end - run.start <= MAX_RUN_MS,
  )
  const own = input.model ? work.filter((run) => run.model === input.model) : []
  const chosen = own.length >= MIN_RUNS ? own : work
  const modelSteps = input.model ? input.steps.filter((step) => step.model === input.model) : []
  const steps = (modelSteps.length >= 10 ? modelSteps : input.steps).map((step) => step.ms).filter((ms) => ms > 0)
  const planned = chosen.filter((run) => run.todos >= 2)
  return {
    runs: chosen.length,
    ...(own.length >= MIN_RUNS ? { model: input.model } : {}),
    runMedianMs: quantile(
      chosen.map((run) => run.end - run.start),
      0.5,
    ),
    runP75Ms: quantile(
      chosen.map((run) => run.end - run.start),
      0.75,
    ),
    stepMedianMs: quantile(steps, 0.5),
    todoMedianMs: quantile(
      planned.map((run) => (run.end - run.start) / run.todos),
      0.5,
    ),
  }
}

/** Where the work in progress stands, as the app sees it. */
export interface Progress {
  elapsed: number
  todos?: { total: number; done: number; active: number }
}

export interface Estimate {
  remaining: number
  /** `plan`: from the agent's todo list; `history`: from how long requests usually take. */
  basis: "plan" | "history"
}

/** Todo items the agent is working on count as half done. */
const ACTIVE_WEIGHT = 0.5
/** Pace from the run itself is trusted only after a few seconds of it. */
const MIN_LIVE_MS = 5000

/**
 * Time left. With a todo list, from the pace the agent keeps on it, or before
 * the first item is done, from past runs; without one, from how long requests
 * usually take. Undefined when there is nothing to go on, or once the run has
 * outlasted most runs and a number would only be a guess.
 */
export function estimate(progress: Progress, pace: Pace | undefined): Estimate | undefined {
  const todos = progress.todos
  if (todos && todos.total > 0) {
    const done = Math.min(todos.total, todos.done + todos.active * ACTIVE_WEIGHT)
    const perTodo =
      done >= 1 && progress.elapsed >= MIN_LIVE_MS
        ? progress.elapsed / done
        : (pace?.todoMedianMs ?? (pace?.stepMedianMs !== undefined ? pace.stepMedianMs * 3 : undefined))
    if (perTodo !== undefined) {
      return { remaining: Math.max(0, Math.round((todos.total - done) * perTodo)), basis: "plan" }
    }
  }
  if (!pace?.runMedianMs) return undefined
  const typical = progress.elapsed < pace.runMedianMs ? pace.runMedianMs : pace.runP75Ms
  if (!typical || typical <= progress.elapsed) return undefined
  return { remaining: typical - progress.elapsed, basis: "history" }
}

export * as SessionPace from "./pace"
