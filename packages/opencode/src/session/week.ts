/**
 * A week of using the agent, from the conversation database: what was worked
 * on, how long the model and the tools took, what it cost, which model made the
 * fewest mistakes and which errors came up most. Spend is in dollars, as the
 * providers price it; the app shows it in the person's currency.
 */

export type MessageRow = {
  sessionID: string
  providerID: string | null
  modelID: string | null
  cost: number | null
  created: number | null
  completed: number | null
}

export type ToolRow = {
  sessionID: string
  messageID: string
  tool: string | null
  status: string | null
  error: string | null
  start: number | null
  end: number | null
}

export type SessionRow = { id: string; title: string; parentID: string | null }

/** Models with fewer tool calls than this are too little to say which errs least. */
const MIN_CALLS = 20

export function summarize(input: {
  since: number
  messages: (MessageRow & { id: string })[]
  tools: ToolRow[]
  sessions: SessionRow[]
  notebook: number
}) {
  const replies = input.messages
  const modelOf = new Map(replies.map((message) => [message.id, modelName(message)]))
  const spent = (tool: ToolRow) => (tool.start && tool.end && tool.end > tool.start ? tool.end - tool.start : 0)
  const toolMs = input.tools.reduce((total, tool) => total + spent(tool), 0)
  const browser = input.tools.filter((tool) => tool.tool?.startsWith("browser_"))
  const replyMs = replies.reduce(
    (total, message) =>
      total +
      (message.created && message.completed && message.completed > message.created
        ? message.completed - message.created
        : 0),
    0,
  )
  const failed = input.tools.filter((tool) => tool.status === "error")

  const models = group(replies, (message) => modelName(message)).map(([model, list]) => {
    const calls = input.tools.filter((tool) => modelOf.get(tool.messageID) === model)
    return {
      model,
      steps: list.length,
      cost: sum(list.map((message) => message.cost ?? 0)),
      tools: calls.length,
      errors: calls.filter((tool) => tool.status === "error").length,
    }
  })
  const reliable = models
    .filter((item) => item.tools >= MIN_CALLS)
    .sort((a, b) => a.errors / a.tools - b.errors / b.tools || b.tools - a.tools)[0]

  const titles = new Map(input.sessions.map((session) => [session.id, session]))
  const sessions = group(replies, (message) => message.sessionID)
    // Subagents' sessions are part of the task that started them.
    .filter(([id]) => !titles.get(id)?.parentID)
    .map(([id, list]) => ({
      id,
      title: titles.get(id)?.title ?? "",
      steps: list.length,
      cost: sum(list.map((message) => message.cost ?? 0)),
    }))
    .sort((a, b) => b.steps - a.steps)

  return {
    since: input.since,
    sessions: sessions.length,
    steps: replies.length,
    cost: sum(replies.map((message) => message.cost ?? 0)),
    // A reply's time less the tools it ran is the model thinking and writing.
    modelMs: Math.max(0, replyMs - toolMs),
    toolMs,
    browserMs: browser.reduce((total, tool) => total + spent(tool), 0),
    tools: input.tools.length,
    errors: failed.length,
    browserActions: browser.length,
    notebook: input.notebook,
    ...(reliable ? { reliable: { model: reliable.model, tools: reliable.tools, errors: reliable.errors } } : {}),
    models: models.sort((a, b) => b.steps - a.steps).slice(0, 8),
    topErrors: group(failed, (tool) => `${tool.tool ?? "?"}: ${errorKind(tool.error ?? "")}`)
      .map(([message, list]) => ({ message, count: list.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    topSessions: sessions.slice(0, 8),
  }
}

function modelName(message: MessageRow) {
  return message.modelID ? `${message.providerID ?? "?"}/${message.modelID}` : "?"
}

/** An error's kind: its first line, with numbers and refs made alike so repeats group. */
function errorKind(error: string) {
  return (error.split("\n")[0] ?? "")
    .replace(/ref_\d+/g, "ref_N")
    .replace(/\d+(\.\d+)?/g, "N")
    .slice(0, 120)
}

function group<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const name = key(item)
    const list = map.get(name)
    if (list) {
      list.push(item)
      continue
    }
    map.set(name, [item])
  }
  return [...map.entries()]
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

export * as SessionWeek from "./week"
