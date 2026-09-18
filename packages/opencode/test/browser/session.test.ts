import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { addressToUrl, Browser, type BrowserEvent } from "@/browser/session"
import { BrowserInstall } from "@/browser/install"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const PAGE = `<!doctype html>
<html>
  <head><title>Session Page</title></head>
  <body>
    <h1>Session</h1>
    <button id="go" onclick="document.title = 'Clicked'">Go</button>
  </body>
</html>`

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-session-"))
const file = path.join(directory, "page.html")
fs.writeFileSync(file, PAGE)
const pageUrl = `file://${file.replace(/\\/g, "/")}`

const it = testEffect(
  LayerNode.compile(LayerNode.group([Browser.node]), [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
        // A profile of its own keeps the test from touching the real one.
        get: () => Effect.succeed({ browser: { headless: true, profile: "test", timeout: 20_000 } }),
      }),
    ],
  ]),
)

/**
 * Exercises the service the tools actually call, rather than the Tab class
 * directly: launching, adopting the first tab, tab bookkeeping and shutdown are
 * only covered here.
 */
const describeBrowser = BrowserInstall.available() ? describe : describe.skip

/** Polls `check` until it holds, so tests wait on events rather than on fixed sleeps. */
function until(check: () => boolean, timeout = 15_000) {
  return Effect.promise(async () => {
    const deadline = Date.now() + timeout
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    return check()
  })
}

describe("address bar", () => {
  test("keeps full URLs as they are", () => {
    expect(addressToUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1")
    expect(addressToUrl("about:blank")).toBe("about:blank")
  })

  test("adds a scheme to bare addresses", () => {
    expect(addressToUrl("github.com/anomalyco")).toBe("https://github.com/anomalyco")
    expect(addressToUrl("localhost:3000")).toBe("http://localhost:3000")
  })

  test("searches for anything that is not an address", () => {
    expect(addressToUrl("gatos fofos")).toBe("https://www.google.com/search?q=gatos%20fofos")
    expect(addressToUrl("googl")).toBe("https://www.google.com/search?q=googl")
  })
})

describeBrowser("browser service", () => {
  it.instance(
    "launches on first use and reports what it is running",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service

        expect((yield* browser.status()).running).toBe(false)

        const tab = yield* browser.tab()
        yield* Effect.promise(() => tab.navigate(pageUrl, "load", 20_000))

        const status = yield* browser.status()
        expect(status.running).toBe(true)
        expect(status.headless).toBe(true)
        expect(status.browser).toBeTruthy()
        expect(status.title).toBe("Session Page")
        expect(status.tabs).toHaveLength(1)
        expect(status.tabs[0]!.active).toBe(true)

        yield* browser.shutdown()
        expect((yield* browser.status()).running).toBe(false)
      }),
    60_000,
  )

  it.instance(
    "opens, switches and closes tabs",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service

        const first = yield* browser.tab()
        yield* Effect.promise(() => first.navigate(pageUrl, "load", 20_000))

        const second = yield* browser.open()
        yield* Effect.promise(() => second.navigate("about:blank", "load", 5_000))

        let tabs = yield* browser.tabs()
        expect(tabs).toHaveLength(2)
        expect(tabs.find((item) => item.active)!.id).toBe(tabs[1]!.id)

        yield* browser.select(tabs[0]!.id)
        expect((yield* browser.status()).title).toBe("Session Page")

        yield* browser.close(tabs[1]!.id)
        tabs = yield* browser.tabs()
        expect(tabs).toHaveLength(1)

        yield* browser.shutdown()
      }),
    60_000,
  )

  it.instance(
    "never starts the browser just to look at it",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service

        // This is what the live panel polls through; a panel must not be the
        // reason a browser process appears.
        expect(yield* browser.current()).toBeUndefined()
        expect((yield* browser.status()).running).toBe(false)

        const tab = yield* browser.tab()
        yield* Effect.promise(() => tab.navigate(pageUrl, "load", 20_000))

        const active = yield* browser.current()
        expect(active).toBeDefined()

        // And the frame the panel draws has to be a real image.
        const shot = yield* Effect.promise(() => active!.screenshot())
        expect(shot.subarray(0, 4).toString("hex")).toBe("89504e47")

        yield* browser.shutdown()
        expect(yield* browser.current()).toBeUndefined()
      }),
    60_000,
  )

  it.instance(
    "restarts cleanly after being shut down",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service

        const before = yield* browser.tab()
        yield* Effect.promise(() => before.navigate(pageUrl, "load", 20_000))
        yield* browser.shutdown()

        const after = yield* browser.tab()
        yield* Effect.promise(() => after.navigate(pageUrl, "load", 20_000))
        expect(yield* Effect.promise(() => after.title())).toBe("Session Page")

        // The snapshot has to work on the restarted browser too, which is what
        // every tool depends on.
        const snapshot = yield* Effect.promise(() => after.snapshot())
        expect(snapshot.outline).toContain('button "Go"')
        expect(snapshot.refs).toBeGreaterThan(0)

        yield* browser.shutdown()
      }),
    90_000,
  )

  it.instance(
    "streams status, frames and what the agent does to a live view",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const events: BrowserEvent[] = []
        const unsubscribe = yield* browser.subscribe((event) => events.push(event))

        const tab = yield* browser.tab()
        yield* Effect.promise(() => tab.navigate(pageUrl, "load", 20_000))
        yield* Effect.promise(() => tab.click("#go"))

        expect(yield* until(() => events.some((event) => event.type === "frame"))).toBe(true)
        const frame = events.find((event) => event.type === "frame")
        // JPEG, and sized in CSS pixels so the view can map clicks back.
        expect(frame?.type === "frame" && frame.frame.data.startsWith("/9j/")).toBe(true)
        expect(frame?.type === "frame" && frame.frame.width > 0).toBe(true)

        const click = events.find((event) => event.type === "activity" && event.activity.kind === "click")
        expect(click?.type === "activity" && click.activity.target).toBe("Go")

        expect(
          yield* until(() =>
            events.some((event) => event.type === "status" && event.status.running && event.status.title === "Clicked"),
          ),
        ).toBe(true)

        // Closing the browser is itself news to anyone watching.
        yield* browser.shutdown()
        expect(events.at(-1)).toEqual({ type: "status", status: { running: false, headless: true, tabs: [] } })
        unsubscribe()
      }),
    60_000,
  )

  it.instance(
    "shows the agent's cursor only while someone is watching",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const tab = yield* browser.tab()
        const overlay = () => tab.evaluate<boolean>("document.querySelector('oc-agent-cursor') !== null")

        yield* Effect.promise(() => tab.navigate(pageUrl, "load", 20_000))
        yield* Effect.promise(() => tab.click("#go"))
        expect(yield* Effect.promise(overlay)).toBe(false)

        const unsubscribe = yield* browser.subscribe(() => {})
        yield* Effect.promise(() => tab.click("#go"))
        expect(yield* Effect.promise(overlay)).toBe(true)

        // The overlay is ours: the model never reads it or sees it.
        const snapshot = yield* Effect.promise(() => tab.snapshot())
        expect(snapshot.outline).not.toContain("oc-agent-cursor")
        const html = yield* Effect.promise(() => tab.html())
        expect(html.html).not.toContain("oc-agent-cursor")

        unsubscribe()
        yield* browser.shutdown()
      }),
    60_000,
  )

  it.instance(
    "lets the person watching drive the page",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service

        // The address bar starts the browser, like opening a new window.
        const opened = yield* browser.control({ action: "navigate", url: pageUrl })
        expect(opened.running).toBe(true)
        const tab = yield* browser.tab()
        yield* Effect.promise(() => tab.waitForLoad("load", 10_000))
        expect(yield* until(() => false, 300)).toBe(false)

        const center = yield* Effect.promise(() =>
          tab.evaluate<{ x: number; y: number }>(
            "(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()",
          ),
        )
        yield* browser.input({ type: "mouse", action: "down", x: center.x, y: center.y, button: "left", buttons: 1 })
        yield* browser.input({ type: "mouse", action: "up", x: center.x, y: center.y, button: "left" })

        expect(yield* Effect.promise(() => tab.title())).toBe("Clicked")

        // The page lays out at the size of the pane showing it, new tabs included.
        yield* browser.control({ action: "resize", width: 812, height: 670 })
        const size = () => tab.evaluate<string>("innerWidth + 'x' + innerHeight")
        expect(yield* Effect.promise(size)).toBe("812x670")

        const tabs = yield* browser.control({ action: "new_tab", url: "about:blank" })
        const fresh = yield* browser.tab()
        expect(yield* Effect.promise(() => fresh.evaluate<string>("innerWidth + 'x' + innerHeight"))).toBe("812x670")
        expect(tabs.tabs).toHaveLength(2)
        const back = tabs.tabs.find((item) => !item.active)!
        yield* browser.control({ action: "close_tab", tab: tabs.tabs.find((item) => item.active)!.id })
        expect((yield* browser.status()).tabs.map((item) => item.id)).toEqual([back.id])

        yield* browser.shutdown()
      }),
    60_000,
  )
})
