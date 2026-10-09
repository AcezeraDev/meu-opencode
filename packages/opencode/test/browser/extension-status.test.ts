import { afterEach, describe, expect, test } from "bun:test"
import { Bridge, EXTENSION_PROTOCOL } from "@/browser/bridge"
import { ExtensionStatus } from "@/browser/extension-status"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

/**
 * What the extension is told about the Lynx, and what it may ask back. The
 * status comes off the same global events the app reads; the requests go out
 * as global events the app acts on. No browser or app is needed for either.
 */

const event = (directory: string, type: string, properties: Record<string, unknown>): GlobalEvent => ({
  directory,
  payload: { type, properties },
})

function harness() {
  const sent: any[] = []
  const bridge = new Bridge("secret")
  bridge.accept(
    (message) => sent.push(message),
    () => {},
  )
  const emitted: GlobalEvent[] = []
  const listen = (item: GlobalEvent) => emitted.push(item)
  GlobalBus.on("event", listen)
  cleanups.push(() => GlobalBus.off("event", listen))
  return {
    bridge,
    sent,
    emitted: (type: string) => emitted.filter((item) => item.payload?.type === type),
    feed: (item: GlobalEvent) => bridge.status.receive(item),
    send: (message: object) => bridge.receive(JSON.stringify(message)),
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("extension status", () => {
  test("follows a session from working, through a permission, to done", () => {
    const tracker = new ExtensionStatus.Tracker()
    const seen: ExtensionStatus.Status[] = []
    tracker.onChange((status) => seen.push(status))

    tracker.receive(event("/p", "session.updated", { info: { id: "s1", title: "Resumir a aula" } }))
    tracker.receive(event("/p", "session.status", { sessionID: "s1", status: { type: "busy" } }))
    tracker.receive(
      event("/p", "message.part.updated", {
        part: { id: "t1", type: "tool", sessionID: "s1", tool: "browser_act", state: { status: "running", title: "Clicando em Enviar" } },
      }),
    )
    expect(tracker.current()).toMatchObject({ phase: "working", session: "Resumir a aula", step: "Clicando em Enviar" })

    tracker.receive(
      event("/p", "permission.asked", { id: "per1", sessionID: "s1", permission: "bash", patterns: ["rm -rf build"] }),
    )
    expect(tracker.current()).toMatchObject({
      phase: "attention",
      ask: { id: "per1", kind: "permission", title: "bash: rm -rf build" },
    })
    expect(tracker.ask("per1")).toMatchObject({ sessionID: "s1", directory: "/p" })
    expect(tracker.running()).toEqual([{ sessionID: "s1", directory: "/p" }])

    tracker.receive(event("/p", "permission.replied", { sessionID: "s1", requestID: "per1", reply: "once" }))
    tracker.receive(event("/p", "session.status", { sessionID: "s1", status: { type: "idle" } }))
    expect(tracker.current()).toMatchObject({ phase: "done", session: "Resumir a aula" })
    expect(tracker.running()).toEqual([])

    tracker.seen()
    expect(tracker.current().phase).toBe("idle")
    expect(seen.map((status) => status.phase)).toEqual(["working", "working", "attention", "working", "done", "idle"])
  })

  test("keeps the answer as it streams, from whole parts and from deltas", () => {
    const tracker = new ExtensionStatus.Tracker()
    tracker.receive(event("/p", "session.status", { sessionID: "s1", status: { type: "busy" } }))
    tracker.receive(event("/p", "message.part.updated", { part: { id: "p1", type: "text", sessionID: "s1", text: "Olá" } }))
    tracker.receive(event("/p", "message.part.delta", { sessionID: "s1", partID: "p1", field: "text", delta: ", tudo" }))
    tracker.receive(event("/p", "message.part.delta", { partID: "p1", field: "text", delta: " certo." }))
    expect(tracker.current().text).toBe("Olá, tudo certo.")
  })

  test("a v2 permission and a question are both waits", () => {
    const tracker = new ExtensionStatus.Tracker()
    tracker.receive(event("/p", "permission.v2.asked", { id: "a", sessionID: "s1", action: "edit", resources: ["x.ts"] }))
    expect(tracker.current().ask).toEqual({ id: "a", kind: "permission", title: "edit: x.ts" })
    tracker.receive(event("/p", "permission.v2.replied", { requestID: "a" }))
    tracker.receive(event("/p", "question.asked", { id: "q", sessionID: "s1", questions: [{ question: "Qual turma?" }] }))
    expect(tracker.current().ask).toEqual({ id: "q", kind: "question", title: "Qual turma?" })
    tracker.receive(event("/p", "question.rejected", { requestID: "q" }))
    expect(tracker.current().phase).toBe("idle")
  })
})

describe("extension requests through the bridge", () => {
  test("pairing welcomes the extension with the wire version and the status", () => {
    const h = harness()
    h.send({ type: "auth", token: "secret", protocol: EXTENSION_PROTOCOL })
    expect(h.sent[0]).toEqual({ type: "welcome", protocol: EXTENSION_PROTOCOL })
    expect(h.sent[1]).toMatchObject({ type: "status", phase: "idle" })
  })

  test("nothing is relayed before the token", () => {
    const h = harness()
    h.send({ type: "ask", text: "oi" })
    expect(h.emitted("lynx.extension.ask")).toHaveLength(0)
  })

  test("an ask goes to the app with its tab and selection", () => {
    const h = harness()
    h.send({ type: "auth", token: "secret" })
    h.send({ type: "ask", text: "  Resuma esta página. ", selection: "trecho", tab: { targetId: "7", url: "https://x.com", title: "X" } })
    h.send({ type: "ask", text: "   " })
    const asks = h.emitted("lynx.extension.ask")
    expect(asks).toHaveLength(1)
    expect(asks[0]!.payload.properties).toEqual({
      text: "Resuma esta página.",
      selection: "trecho",
      follow: false,
      tab: { targetId: "7", url: "https://x.com", title: "X" },
    })
  })

  test("Stop names the sessions working now", () => {
    const h = harness()
    h.send({ type: "auth", token: "secret" })
    h.feed(event("/p", "session.status", { sessionID: "s1", status: { type: "busy" } }))
    h.send({ type: "stop" })
    expect(h.emitted("lynx.extension.stop")[0]!.payload.properties).toEqual({
      sessions: [{ sessionID: "s1", directory: "/p" }],
    })
  })

  test("an answer only reaches a permission that is waiting", () => {
    const h = harness()
    h.send({ type: "auth", token: "secret" })
    h.send({ type: "answer", requestID: "nope", reply: "once" })
    h.feed(event("/p", "question.asked", { id: "q", sessionID: "s1", questions: [] }))
    h.send({ type: "answer", requestID: "q", reply: "once" })
    expect(h.emitted("lynx.extension.answer")).toHaveLength(0)

    h.feed(event("/p", "permission.asked", { id: "per", sessionID: "s1", permission: "bash" }))
    h.send({ type: "answer", requestID: "per", reply: "reject" })
    expect(h.emitted("lynx.extension.answer")[0]!.payload.properties).toMatchObject({
      id: "per",
      sessionID: "s1",
      directory: "/p",
      reply: "reject",
    })
  })
})
