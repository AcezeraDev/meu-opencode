type TrayStatus = "idle" | "working" | "done" | "attention"
type ServerEvent = { name: string; details?: { type: string; properties?: unknown } }
type EventProps = {
  id?: string
  requestID?: string
  sessionID?: string
  status?: { type?: string }
  part?: { type?: string; tool?: string; sessionID?: string; state?: { status?: string; title?: string } }
}

/**
 * Follows the server's events and keeps the tray icon next to the clock in
 * step with the agent: working (with the step it is on), done, or waiting for
 * the person to answer a permission or a question. "Done" stays until the
 * person comes back to the app, so a finished task is not missed.
 */
export function trackAgentTray(input: {
  listen: (cb: (event: ServerEvent) => void) => () => void
  setTray: (state: { status: TrayStatus; tooltip: string }) => void
  autoResponds: (properties: never, directory: string) => boolean
  title: (directory: string, sessionID: string) => string | undefined
  text: {
    idle: string
    working: (session: string, step?: string) => string
    done: (session: string) => string
    attention: (session: string) => string
  }
}) {
  const busy = new Map<string, string>()
  const asks = new Map<string, { sessionID: string; directory: string }>()
  const steps = new Map<string, string>()
  const state = { finished: undefined as { sessionID: string; directory: string } | undefined, shown: "" }

  const name = (directory: string, sessionID: string) => input.title(directory, sessionID) ?? "Lynx Code"

  const show = () => {
    const ask = [...asks.values()].at(-1)
    const working = [...busy.entries()].at(-1)
    const next = ask
      ? { status: "attention" as const, tooltip: input.text.attention(name(ask.directory, ask.sessionID)) }
      : working
        ? {
            status: "working" as const,
            tooltip: input.text.working(name(working[1], working[0]), steps.get(working[0])),
          }
        : state.finished
          ? {
              status: "done" as const,
              tooltip: input.text.done(name(state.finished.directory, state.finished.sessionID)),
            }
          : { status: "idle" as const, tooltip: input.text.idle }
    const key = next.status + next.tooltip
    if (key === state.shown) return
    state.shown = key
    input.setTray(next)
  }

  const unsub = input.listen((event) => {
    const type = event.details?.type
    const props = (event.details?.properties ?? {}) as EventProps
    const directory = event.name
    if (type === "session.status" && props.sessionID) {
      const sessionID = props.sessionID
      if (props.status?.type === "idle") {
        if (busy.delete(sessionID)) state.finished = { sessionID, directory }
        steps.delete(sessionID)
      }
      if (props.status?.type !== "idle") {
        busy.set(sessionID, directory)
        state.finished = undefined
      }
      return show()
    }
    if ((type === "permission.asked" || type === "question.asked") && props.id && props.sessionID) {
      if (type === "permission.asked" && input.autoResponds(props as never, directory)) return
      asks.set(props.id, { sessionID: props.sessionID, directory })
      return show()
    }
    if (type === "permission.replied" || type === "question.replied" || type === "question.rejected") {
      if (props.requestID) asks.delete(props.requestID)
      return show()
    }
    if (type === "message.part.updated") {
      const part = props.part
      if (part?.type !== "tool" || part.state?.status !== "running" || !part.sessionID || !busy.has(part.sessionID))
        return
      steps.set(part.sessionID, part.state.title || part.tool || "")
      return show()
    }
  })

  return {
    /** The person came back to the app, so a finished task has been seen. */
    seen() {
      if (!state.finished) return
      state.finished = undefined
      show()
    },
    dispose() {
      unsub()
      input.setTray({ status: "idle", tooltip: input.text.idle })
    },
  }
}
