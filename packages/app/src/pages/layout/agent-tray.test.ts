import { describe, expect, test } from "bun:test"
import { trackAgentTray } from "./agent-tray"

function setup(autoResponds = false) {
  const shown: { status: string; tooltip: string }[] = []
  let emit = (_event: { name: string; details: { type: string; properties: unknown } }) => {}
  const tracker = trackAgentTray({
    listen: (cb) => {
      emit = cb
      return () => {}
    },
    setTray: (state) => shown.push(state),
    autoResponds: () => autoResponds,
    title: (_directory, sessionID) => `Sessão ${sessionID}`,
    text: {
      idle: "OpenCode",
      working: (session, step) => `Trabalhando: ${session}${step ? ` · ${step}` : ""}`,
      done: (session) => `Terminou: ${session}`,
      attention: (session) => `Precisa de você: ${session}`,
    },
  })
  const send = (type: string, properties: unknown) => emit({ name: "/projeto", details: { type, properties } })
  return { shown, send, tracker, last: () => shown.at(-1) }
}

describe("agent tray", () => {
  test("shows the step a working session is on, then done until the person comes back", () => {
    const tray = setup()
    tray.send("session.status", { sessionID: "a", status: { type: "busy" } })
    expect(tray.last()).toEqual({ status: "working", tooltip: "Trabalhando: Sessão a" })

    tray.send("message.part.updated", {
      part: { type: "tool", tool: "browser_act", sessionID: "a", state: { status: "running", title: "Clicar em Enviar" } },
    })
    expect(tray.last()).toEqual({ status: "working", tooltip: "Trabalhando: Sessão a · Clicar em Enviar" })

    tray.send("session.status", { sessionID: "a", status: { type: "idle" } })
    expect(tray.last()).toEqual({ status: "done", tooltip: "Terminou: Sessão a" })

    tray.tracker.seen()
    expect(tray.last()).toEqual({ status: "idle", tooltip: "OpenCode" })
  })

  test("a question waiting for the person wins over work, and clears when answered", () => {
    const tray = setup()
    tray.send("session.status", { sessionID: "a", status: { type: "busy" } })
    tray.send("question.asked", { id: "q1", sessionID: "a" })
    expect(tray.last()).toEqual({ status: "attention", tooltip: "Precisa de você: Sessão a" })

    tray.send("question.replied", { sessionID: "a", requestID: "q1" })
    expect(tray.last()?.status).toBe("working")
  })

  test("a permission the app answers by itself does not ask for the person", () => {
    const tray = setup(true)
    tray.send("session.status", { sessionID: "a", status: { type: "busy" } })
    tray.send("permission.asked", { id: "p1", sessionID: "a" })
    expect(tray.last()?.status).toBe("working")
  })

  test("the same state is not sent twice", () => {
    const tray = setup()
    tray.send("session.status", { sessionID: "a", status: { type: "busy" } })
    tray.send("session.status", { sessionID: "a", status: { type: "busy" } })
    expect(tray.shown.length).toBe(1)
  })
})
