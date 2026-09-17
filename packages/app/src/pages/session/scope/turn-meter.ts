import type { AssistantMessage, Message, Part, ToolPart, UserMessage } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { useSync } from "@/context/sync"

/** How often the live readouts sample the stream. */
const SAMPLE_MS = 500
/** Seconds of rate history kept for the trace. */
const TRACE_SAMPLES = 48
/** Rough characters per token, only for the live rate while token counts are not reported yet. */
const CHARS_PER_TOKEN = 4

export type TurnStep =
  | { kind: "waiting" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "tool"; tool: string; target?: string }

export type Turn = { user: UserMessage; assistants: AssistantMessage[] }

/** The latest user message and the assistant messages answering it. */
export function lastTurn(messages: Message[]): Turn | undefined {
  const index = messages.findLastIndex((message) => message.role === "user")
  if (index < 0) return
  return {
    user: messages[index] as UserMessage,
    assistants: messages
      .slice(index + 1)
      .filter((message): message is AssistantMessage => message.role === "assistant"),
  }
}

/** Every turn in order, keyed by its user message. */
export function turnFor(messages: Message[], userMessageID: string): Turn | undefined {
  const index = messages.findIndex((message) => message.id === userMessageID)
  if (index < 0 || messages[index].role !== "user") return
  const next = messages.findIndex((message, position) => position > index && message.role === "user")
  const slice = messages.slice(index + 1, next < 0 ? undefined : next)
  return {
    user: messages[index] as UserMessage,
    assistants: slice.filter((message): message is AssistantMessage => message.role === "assistant"),
  }
}

export function toolTarget(part: ToolPart) {
  const input = part.state.input as Record<string, unknown>
  const pick = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined)
  const file = pick("filePath") ?? pick("path")
  if (file) return file.split(/[\\/]/).at(-1)
  const command = pick("command")
  if (command) return command.length > 48 ? `${command.slice(0, 47)}…` : command
  return pick("pattern") ?? pick("query") ?? pick("url") ?? pick("description")
}

export function turnStats(turn: Turn, parts: (id: string) => Part[]) {
  const tools = turn.assistants.flatMap((message) =>
    parts(message.id).filter((part): part is ToolPart => part.type === "tool"),
  )
  const completed = turn.assistants.map((message) => message.time.completed).filter((value) => value !== undefined)
  const end = completed.length > 0 ? Math.max(...completed) : undefined
  const generating = turn.assistants.reduce(
    (sum, message) => sum + Math.max(0, (message.time.completed ?? message.time.created) - message.time.created),
    0,
  )
  const output = turn.assistants.reduce((sum, message) => sum + message.tokens.output + message.tokens.reasoning, 0)
  return {
    duration: end === undefined ? 0 : Math.max(0, end - turn.user.time.created),
    tools: tools.length,
    files: new Set((turn.user.summary?.diffs ?? []).map((diff) => diff.file)).size,
    output,
    rate: generating > 0 ? output / (generating / 1000) : 0,
    cost: turn.assistants.reduce((sum, message) => sum + (message.cost ?? 0), 0),
  }
}

/**
 * Live measurements of the turn the agent is working on: elapsed time, a streaming
 * rate estimated from characters as they arrive (token counts only land when a step
 * ends), the step in progress, steps done and cost so far.
 */
export function createTurnMeter(input: { sessionID: () => string | undefined; active: () => boolean }) {
  const sync = useSync()
  const parts = (id: string) => (sync().data.part[id] ?? []) as Part[]
  const turn = createMemo(() => {
    const id = input.sessionID()
    return id ? lastTurn((sync().data.message[id] ?? []) as Message[]) : undefined
  })

  // Output produced so far, in tokens. Finished steps report exact counts; the step
  // still streaming is estimated from what has arrived (text, reasoning, tool input).
  const produced = createMemo(() =>
    (turn()?.assistants ?? []).reduce((sum, message) => {
      if (message.time.completed !== undefined || message.tokens.output > 0)
        return sum + message.tokens.output + message.tokens.reasoning
      const chars = parts(message.id).reduce((inner, part) => {
        if (part.type === "text" || part.type === "reasoning") return inner + part.text.length
        if (part.type === "tool") return inner + JSON.stringify(part.state.input ?? {}).length
        return inner
      }, 0)
      return sum + chars / CHARS_PER_TOKEN
    }, 0),
  )

  const [now, setNow] = createSignal(Date.now())
  const [rate, setRate] = createSignal(0)
  const [trace, setTrace] = createSignal<number[]>([])

  createEffect(() => {
    if (!input.active()) return
    // Read without tracking: this effect must restart only when the turn goes live.
    let previous = untrack(produced)
    let smoothed = 0
    setTrace([])
    const timer = setInterval(() => {
      setNow(Date.now())
      const current = produced()
      const instant = Math.max(0, current - previous) / (SAMPLE_MS / 1000)
      previous = current
      smoothed = smoothed * 0.6 + instant * 0.4
      setRate(smoothed)
      setTrace((values) => [...values, smoothed].slice(-TRACE_SAMPLES))
    }, SAMPLE_MS)
    onCleanup(() => clearInterval(timer))
  })

  // Steps span several assistant messages, and bookkeeping parts (step start/finish,
  // snapshots) sit between them, so read the turn's last meaningful part.
  const step = createMemo<TurnStep>(() => {
    const list = (turn()?.assistants ?? []).flatMap((message) =>
      parts(message.id).filter((part) => part.type === "text" || part.type === "reasoning" || part.type === "tool"),
    )
    const running = list.findLast(
      (part): part is ToolPart =>
        part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"),
    )
    if (running) return { kind: "tool", tool: running.tool, target: toolTarget(running) }
    const tail = list.at(-1)
    if (!tail) return { kind: "waiting" }
    if (tail.type === "text") return { kind: "writing" }
    return { kind: "thinking" }
  })

  const steps = createMemo(
    () =>
      (turn()?.assistants ?? []).flatMap((message) =>
        parts(message.id).filter(
          (part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
        ),
      ).length,
  )

  return {
    turn,
    elapsed: () => {
      const current = turn()
      return current ? Math.max(0, now() - current.user.time.created) : 0
    },
    rate,
    trace,
    step,
    steps,
    cost: () => (turn()?.assistants ?? []).reduce((sum, message) => sum + (message.cost ?? 0), 0),
  }
}
