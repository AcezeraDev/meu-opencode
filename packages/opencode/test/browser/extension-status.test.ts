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

describe("the side panel's calls", () => {
  async function call(message: object) {
    const sent: any[] = []
    const bridge = new Bridge("secret")
    bridge.accept(
      (item) => sent.push(item),
      () => {},
      "http://127.0.0.1:9",
    )
    bridge.receive(JSON.stringify({ type: "auth", token: "secret" }))
    bridge.receive(JSON.stringify({ type: "api", rid: 1, ...message }))
    for (let wait = 0; wait < 100 && !sent.some((item) => item.type === "api"); wait++) await Bun.sleep(20)
    return sent.find((item) => item.type === "api")
  }

  test("only reach the routes a chat needs", async () => {
    expect(await call({ method: "GET", path: "/auth/openai" })).toMatchObject({ rid: 1, status: 403 })
    expect(await call({ method: "POST", path: "/config" })).toMatchObject({ status: 403 })
    expect(await call({ method: "DELETE", path: "/project/p_1" })).toMatchObject({ status: 403 })
    expect(await call({ method: "GET", path: "http://evil.example/session" })).toMatchObject({ status: 403 })
    expect(await call({ method: "GET", path: "/session/../auth/x" })).toMatchObject({ status: 403 })
  })

  test("an allowed route is called on this server", async () => {
    // Nothing listens on port 9, so the call is made and fails there.
    expect(await call({ method: "GET", path: "/session?directory=x" })).toMatchObject({ rid: 1, status: 502 })
  })
})

describe("one browser at a time", () => {
  function pair(bridge: Bridge, instance?: string, take?: boolean) {
    const sent: any[] = []
    let closed = false
    const link = bridge.accept(
      (message) => sent.push(message),
      () => {
        closed = true
      },
    )
    link.receive(JSON.stringify({ type: "auth", token: "secret", instance, take }))
    return { link, sent, closed: () => closed }
  }

  test("another browser waits instead of knocking the first one off", () => {
    const bridge = new Bridge("secret")
    const brave = pair(bridge, "brave")
    const edge = pair(bridge, "edge")
    expect(edge.sent).toEqual([{ type: "busy" }])
    expect(edge.closed()).toBe(true)
    expect(brave.closed()).toBe(false)
    expect(bridge.connected).toBe(true)
  })

  test("the same browser coming back, an old extension, or one told to take over replaces it", () => {
    const bridge = new Bridge("secret")
    const first = pair(bridge, "brave")
    const again = pair(bridge, "brave")
    expect(first.closed()).toBe(true)
    expect(again.sent[0]).toMatchObject({ type: "welcome" })

    const old = pair(bridge)
    expect(again.closed()).toBe(true)
    expect(old.sent[0]).toMatchObject({ type: "welcome" })

    const taker = pair(bridge, "edge", true)
    expect(taker.sent[0]).toMatchObject({ type: "welcome" })
  })

  test("a browser can pair once the other one left", () => {
    const bridge = new Bridge("secret")
    const brave = pair(bridge, "brave")
    brave.link.disconnect()
    const edge = pair(bridge, "edge")
    expect(edge.sent[0]).toMatchObject({ type: "welcome" })
  })

  test("a wrong token from a second browser is refused without disturbing the first", () => {
    const bridge = new Bridge("secret")
    const brave = pair(bridge, "brave")
    let closed = false
    const intruder = bridge.accept(
      () => {},
      () => {
        closed = true
      },
    )
    intruder.receive(JSON.stringify({ type: "auth", token: "nope", instance: "x" }))
    expect(closed).toBe(true)
    expect(brave.closed()).toBe(false)
  })
})
