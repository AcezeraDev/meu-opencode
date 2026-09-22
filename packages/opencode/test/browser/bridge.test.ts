import { describe, expect, test } from "bun:test"
import path from "path"
import { Bridge, type TargetEvent } from "@/browser/bridge"
import { TAB_EVENTS } from "@/browser/protocol"

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
  test("relays every CDP event a tab listens to", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/browser/tab.ts")).text()
    const listened = Array.from(source.matchAll(/this\.connection\.(?:on|once)\("([^"]+)"/g), (match) => match[1]!)
    expect([...new Set(listened)].sort()).toEqual([
      "Input.dragIntercepted",
      "Network.loadingFailed",
      "Network.loadingFinished",
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Page.domContentEventFired",
      "Page.frameNavigated",
      "Page.frameStartedLoading",
      "Page.frameStoppedLoading",
      "Page.javascriptDialogOpening",
      "Page.loadEventFired",
      "Page.screencastFrame",
      "Runtime.consoleAPICalled",
      "Runtime.exceptionThrown",
    ])
    expect(listened.every((event) => TAB_EVENTS.includes(event as (typeof TAB_EVENTS)[number]))).toBe(true)
  })

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

  test("a command that finds the tab unattached re-attaches and tries once more", async () => {
    const tick = async (pred: () => boolean) => {
      for (let i = 0; i < 100; i++) {
        if (pred()) return
        await new Promise((r) => setTimeout(r, 2))
      }
      throw new Error("condition never held")
    }
    const h = harness()
    h.auth()
    const tab = h.bridge.connection("7")

    const done = tab.send("Runtime.evaluate", { expression: "1+1" })
    const first = h.last()
    expect(first).toMatchObject({ type: "command", targetId: "7", method: "Runtime.evaluate" })
    // The extension's worker restarted and lost the debugger for this tab.
    h.fail(first.id, "Debugger is not attached to the tab with id: 7")

    await tick(() => h.last()?.type === "attach")
    const attach = h.last()
    expect(attach).toMatchObject({ type: "attach", targetId: "7" })
    h.reply(attach.id, {})

    await tick(() => h.last()?.type === "command" && h.last().id !== first.id)
    h.reply(h.last().id, { result: { value: 2 } })
    expect(await done).toEqual({ result: { value: 2 } })
  })

  test("a command that fails for another reason is not retried", async () => {
    const h = harness()
    h.auth()
    const tab = h.bridge.connection("8")

    const done = tab.send("Page.navigate", { url: "x" })
    h.fail(h.last().id, "net::ERR_ABORTED")
    await expect(done).rejects.toThrow(/ERR_ABORTED/)
    expect(h.sent.filter((message) => message.type === "attach")).toHaveLength(0)
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

  test("a tab the debugger was thrown off gets a fresh transport, and its waits fail at once", async () => {
    const h = harness()
    h.auth()
    const dead = h.bridge.connection("5")
    const waiting = dead.once("Page.loadEventFired", 60_000).then(
      () => "fired",
      (error: Error) => error.message,
    )
    // What the browser does when the tab opens its PDF viewer.
    h.bridge.receive(JSON.stringify({ type: "detached", targetId: "5", reason: "target_closed" }))
    expect(await waiting).toContain("not connected")
    expect(dead.connected).toBe(false)

    const fresh = h.bridge.connection("5")
    expect(fresh).not.toBe(dead)
    expect(fresh.connected).toBe(true)
    // Closing the old one late must not throw away the new one.
    dead.close()
    expect(h.bridge.connection("5")).toBe(fresh)
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
