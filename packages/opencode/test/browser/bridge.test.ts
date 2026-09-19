import { describe, expect, test } from "bun:test"
import { Bridge, type TargetEvent } from "@/browser/bridge"

/**
 * The bridge multiplexes one extension socket into per-tab transports. None of
 * that needs a real browser, so it is exercised here with a fake socket: an
 * array of what the bridge wrote, and hand-fed replies and events.
 */
function harness(token = "secret") {
  const sent: any[] = []
  let closed = false
  const bridge = new Bridge(token)
  bridge.accept(
    (message) => sent.push(message),
    () => {
      closed = true
    },
  )
  return {
    bridge,
    sent,
    closed: () => closed,
    /** The last request written, so a reply can echo its id. */
    last: () => sent[sent.length - 1],
    reply: (id: number, result: unknown) => bridge.receive(JSON.stringify({ id, type: "result", result })),
    fail: (id: number, error: string) => bridge.receive(JSON.stringify({ id, type: "error", error })),
    auth: (t = token) => bridge.receive(JSON.stringify({ type: "auth", token: t })),
  }
}

describe("browser bridge", () => {
  test("stays closed until the right token arrives, and drops a wrong one", () => {
    const h = harness()
    expect(h.bridge.connected).toBe(false)
    h.auth("wrong")
    expect(h.bridge.connected).toBe(false)
    expect(h.closed()).toBe(true)

    const ok = harness()
    let states = 0
    ok.bridge.onState(() => states++)
    ok.auth()
    expect(ok.bridge.connected).toBe(true)
    expect(states).toBe(1)
  })

  test("a request before auth is rejected, not sent", async () => {
    const h = harness()
    await expect(h.bridge.listTargets()).rejects.toThrow(/not connected/)
    expect(h.sent).toHaveLength(0)
  })

  test("matches replies to requests by id", async () => {
    const h = harness()
    h.auth()
    const targets = h.bridge.listTargets()
    expect(h.last()).toMatchObject({ type: "listTargets" })
    h.reply(h.last().id, { targets: [{ targetId: "7", url: "https://x", title: "X", active: true }] })
    expect(await targets).toEqual([{ targetId: "7", url: "https://x", title: "X", active: true }])
  })

  test("a tab transport sends commands and surfaces errors", async () => {
    const h = harness()
    h.auth()
    const tab = h.bridge.connection("7")

    const ok = tab.send("Runtime.evaluate", { expression: "1+1" })
    expect(h.last()).toMatchObject({ type: "command", targetId: "7", method: "Runtime.evaluate" })
    h.reply(h.last().id, { result: { value: 2 } })
    expect(await ok).toEqual({ result: { value: 2 } })

    const bad = tab.send("Page.navigate", { url: "x" })
    h.fail(h.last().id, "boom")
    await expect(bad).rejects.toThrow(/boom/)
  })

  test("routes CDP events to the right tab", () => {
    const h = harness()
    h.auth()
    const a = h.bridge.connection("1")
    const b = h.bridge.connection("2")
    const hitsA: unknown[] = []
    const hitsB: unknown[] = []
    a.on("Page.loadEventFired", (p) => hitsA.push(p))
    b.on("Page.loadEventFired", (p) => hitsB.push(p))

    h.bridge.receive(JSON.stringify({ type: "event", targetId: "1", method: "Page.loadEventFired", params: { at: 1 } }))
    expect(hitsA).toEqual([{ at: 1 }])
    expect(hitsB).toEqual([])
  })

  test("hands tab lifecycle to listeners", () => {
    const h = harness()
    h.auth()
    const seen: TargetEvent[] = []
    h.bridge.onTarget((e) => seen.push(e))
    h.bridge.receive(
      JSON.stringify({ type: "target", event: "created", target: { targetId: "9", url: "https://y", active: true } }),
    )
    expect(seen).toEqual([{ event: "created", target: { targetId: "9", url: "https://y", active: true } }])
  })

  test("a detached tab reports itself closed", () => {
    const h = harness()
    h.auth()
    const tab = h.bridge.connection("3")
    expect(tab.connected).toBe(true)
    h.bridge.receive(JSON.stringify({ type: "detached", targetId: "3", reason: "target_closed" }))
    expect(tab.connected).toBe(false)
  })

  test("disconnecting fails in-flight calls and closes tabs", async () => {
    const h = harness()
    h.auth()
    const tab = h.bridge.connection("4")
    const inflight = tab.send("Runtime.evaluate", {})
    h.bridge.disconnect()
    await expect(inflight).rejects.toThrow(/disconnected/)
    expect(h.bridge.connected).toBe(false)
    expect(tab.connected).toBe(false)
  })
})
