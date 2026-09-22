import fs from "fs"
import path from "path"
import { afterAll, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Browser } from "@/browser/session"
import { BrowserBridge, type BridgeTarget } from "@/browser/bridge"
import { TAB_EVENTS, TAB_FIELDS } from "@/browser/protocol"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const TOKEN = "extension-test-token"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Browser.node]), [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
        get: () => Effect.succeed({ browser: { mode: "extension", extensionToken: TOKEN, timeout: 5_000 } }),
      }),
    ],
  ]),
)

afterAll(() => BrowserBridge.reset())

/** The element every lookup in the fake page finds. */
const ELEMENT = { x: 100, y: 100, width: 80, height: 30, name: "Send", checked: false, duration: 0 }

/** What Chrome answers when asked to debug a tab showing its PDF viewer. */
const REFUSED = "Cannot access a chrome-extension:// URL of different extension"

/**
 * Stands in for the extension in the person's browser: it pairs with the
 * process bridge and answers every request the way a real tab would, closely
 * enough for the session to drive it. Everything the bridge sends is recorded.
 * Tabs in `refuse` cannot be attached, like one showing a PDF; going back
 * from one lets it be attached again.
 */
function pairFakeExtension(options: { targets?: BridgeTarget[]; refuse?: Set<string> } = {}) {
  BrowserBridge.reset()
  const bridge = BrowserBridge.instance()
  bridge.configure(TOKEN)
  const targets = options.targets ?? [{ targetId: "7", url: "https://example.com/", title: "Example", active: true }]
  const refuse = options.refuse ?? new Set<string>()
  const sent: any[] = []
  const answer = (message: any) => {
    const reply = (result: unknown) => bridge.receive(JSON.stringify({ id: message.id, type: "result", result }))
    const fail = (error: string) => bridge.receive(JSON.stringify({ id: message.id, type: "error", error }))
    if (message.type === "listTargets") return reply({ targets })
    if (message.type === "attach" && refuse.has(message.targetId)) return fail(REFUSED)
    if (message.type === "createTarget") return reply({ targetId: "8" })
    if (message.type === "goBack") {
      reply({})
      setTimeout(() => {
        refuse.delete(message.targetId)
        bridge.receive(
          JSON.stringify({
            type: "target",
            event: "updated",
            target: { targetId: message.targetId, url: "https://example.com/aula", title: "Aula", active: true },
          }),
        )
      }, 50)
      return
    }
    if (message.type !== "command") return reply({})
    if (message.method === "Page.getFrameTree") return reply({ frameTree: { frame: { id: "main" } } })
    if (message.method !== "Runtime.evaluate") return reply({})
    const expression = String(message.params?.expression ?? "")
    if (expression === "document.location.href") return reply({ result: { value: "https://example.com/" } })
    if (expression === "document.title") return reply({ result: { value: "Example" } })
    if (expression.includes("getBoundingClientRect")) return reply({ result: { value: ELEMENT } })
    return reply({ result: { value: true } })
  }
  bridge.accept(
    (message) => {
      sent.push(message)
      queueMicrotask(() => answer(message))
    },
    () => {},
  )
  bridge.receive(JSON.stringify({ type: "auth", token: TOKEN }))
  return { bridge, sent }
}

describe("browser service in extension mode", () => {
  it.instance(
    "drives the person's own browser at its own size, with the cursor always shown",
    () =>
      Effect.gen(function* () {
        const { sent } = pairFakeExtension()
        const browser = yield* Browser.Service

        expect(yield* browser.mode()).toBe("extension")
        // A real window on the person's screen: never reported as headless.
        const status = yield* browser.status()
        expect(status.running).toBe(true)
        expect(status.headless).toBe(false)

        yield* browser.control({ action: "resize", width: 800, height: 600 })
        const tab = yield* browser.tab()
        const commands = () => sent.filter((message) => message.type === "command").map((message) => message.method)

        // Only the events a tab reads are asked for.
        const attach = sent.find((message) => message.type === "attach")
        expect(attach.events).toContain("Page.frameStartedLoading")
        expect(attach.events).not.toContain("Network.dataReceived")

        // The pane's size is never forced on the person's window, and one
        // forced earlier is undone.
        expect(commands()).toContain("Emulation.clearDeviceMetricsOverride")
        // Behind opencode the window is covered; the tab must keep rendering anyway.
        expect(commands()).toContain("Emulation.setFocusEmulationEnabled")
        expect(commands()).not.toContain("Emulation.setDeviceMetricsOverride")

        // Nobody has the live view open, yet the cursor goes along, because
        // the person is looking at the browser itself.
        yield* Effect.promise(() => tab.hover("#go"))
        const scripts = sent
          .filter((message) => message.method === "Runtime.evaluate")
          .map((message) => String(message.params.expression))
        expect(scripts.some((script) => script.includes("__ocAgentCursor"))).toBe(true)

        yield* browser.shutdown()
      }),
    30_000,
  )

  it.instance(
    "a command that finds the tab unattached re-attaches and tries once more",
    () =>
      Effect.gen(function* () {
        BrowserBridge.reset()
        const bridge = BrowserBridge.instance()
        bridge.configure(TOKEN)
        const sent: any[] = []
        let attaches = 0
        let refused = false
        const answer = (message: any) => {
          const reply = (result: unknown) => bridge.receive(JSON.stringify({ id: message.id, type: "result", result }))
          const fail = (error: string) => bridge.receive(JSON.stringify({ id: message.id, type: "error", error }))
          if (message.type === "listTargets")
            return reply({ targets: [{ targetId: "7", url: "https://example.com/", title: "Example", active: true }] })
          if (message.type === "attach") {
            attaches++
            return reply({})
          }
          if (message.type !== "command") return reply({})
          // The tab's debugger was thrown off once; the first command after that
          // bounces, and only a fresh attach lets the retry through.
          if (!refused && message.method === "Runtime.evaluate") {
            refused = true
            return fail("Debugger is not attached to the tab with id: 7")
          }
          if (message.method === "Page.getFrameTree") return reply({ frameTree: { frame: { id: "main" } } })
          return reply({ result: { value: "https://example.com/" } })
        }
        bridge.accept(
          (message) => {
            sent.push(message)
            queueMicrotask(() => answer(message))
          },
          () => {},
        )
        bridge.receive(JSON.stringify({ type: "auth", token: TOKEN }))

        const browser = yield* Browser.Service
        const tab = yield* browser.tab()
        // The url read bounces on the stale tab, then goes through after a re-attach.
        const url = yield* Effect.promise(() => tab.url())
        expect(url).toBe("https://example.com/")
        expect(attaches).toBeGreaterThan(1)

        yield* browser.shutdown()
      }),
    30_000,
  )

  it.instance(
    "a tab showing a PDF does not leave the agent stuck",
    () =>
      Effect.gen(function* () {
        const pdf = "https://cdn.example.com/aulas/S15A4.pdf"
        const { bridge, sent } = pairFakeExtension({
          targets: [{ targetId: "7", url: pdf, title: "Aula", active: true }],
          refuse: new Set(["7"]),
        })
        const browser = yield* Browser.Service

        // The focused tab refuses the debugger, so the agent gets a tab of its own.
        const own = yield* browser.tab()
        expect(own.targetId).toBe("8")
        expect(sent.some((message) => message.type === "createTarget")).toBe(true)

        // Asking for the PDF tab explains what to do instead of failing obscurely.
        const exit = yield* Effect.exit(browser.select("7"))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("browser_navigate with its URL")

        // And the same tab, once its debugger is thrown off by a PDF, is
        // taken back and driven again.
        bridge.receive(JSON.stringify({ type: "detached", targetId: "8", reason: "target_closed" }))
        expect(own.connected).toBe(false)
        const back = yield* browser.leavePdf(own)
        expect(back).toBe(true)
        expect(sent.some((message) => message.type === "goBack" && message.targetId === "8")).toBe(true)
        const again = yield* browser.tab()
        expect(again.connected).toBe(true)
        expect(again.targetId).toBe("8")

        yield* browser.shutdown()
      }),
    30_000,
  )
})

/**
 * The relay in `browser-extension/background.js` keeps only the fields
 * `protocol.ts` asks for. That table is the one place saying what the engine
 * reads, and nothing type-checks it against the plain JavaScript that applies
 * it, so the extension's own function is loaded here and held to it.
 */
describe("the extension relay's pruning", () => {
  /** Loads the service worker with enough of `chrome` to reach the end of the file. */
  function loadRelay() {
    const source = fs.readFileSync(path.join(import.meta.dir, "../../../../browser-extension/background.js"), "utf8")
    const listener = () => ({ addListener: () => {} })
    const chrome = {
      // No token, so it never opens a socket.
      storage: { local: { get: async () => ({}) }, onChanged: listener() },
      debugger: { onEvent: listener(), onDetach: listener() },
      tabs: { onCreated: listener(), onUpdated: listener(), onActivated: listener(), onRemoved: listener() },
      runtime: { onMessage: listener(), onStartup: listener(), onInstalled: listener() },
    }
    const load = new Function("chrome", `${source}\nreturn { prune }`) as (chrome: unknown) => {
      prune: (params: unknown, paths: readonly string[]) => Record<string, any>
    }
    return load(chrome)
  }

  test("a response keeps what the tab reads and drops the rest", () => {
    const { prune } = loadRelay()
    const event = {
      requestId: "req-1",
      type: "Document",
      frameId: "frame-1",
      loaderId: "loader-1",
      timestamp: 12345.678,
      response: {
        url: "https://example.com/",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        mimeType: "text/html",
        requestHeaders: { cookie: "a".repeat(4000) },
        timing: { requestTime: 1, dnsStart: 2, sslEnd: 3 },
        securityDetails: { certificateId: 1, sanList: ["example.com"], validTo: 99 },
      },
    }
    const kept = prune(event, TAB_FIELDS["Network.responseReceived"]!)
    expect(kept["requestId"]).toBe("req-1")
    expect(kept["type"]).toBe("Document")
    expect(kept["frameId"]).toBe("frame-1")
    expect(kept["response"].status).toBe(200)
    expect(kept["response"].url).toBe("https://example.com/")
    // Blocked pages are told apart by a header, so those have to survive.
    expect(kept["response"].headers["cf-mitigated"]).toBe("challenge")
    expect(kept["response"].securityDetails).toBeUndefined()
    expect(kept["response"].timing).toBeUndefined()
    expect(kept["response"].requestHeaders).toBeUndefined()
    expect(JSON.stringify(kept).length).toBeLessThan(JSON.stringify(event).length / 4)
  })

  test("a request keeps its method and address, without the initiator's stack", () => {
    const { prune } = loadRelay()
    const event = {
      requestId: "req-2",
      type: "XHR",
      documentURL: "https://example.com/",
      request: {
        url: "https://example.com/answer",
        method: "POST",
        headers: { accept: "*/*" },
        postData: "x".repeat(2000),
      },
      initiator: { type: "script", stack: { callFrames: new Array(40).fill({ functionName: "f", url: "u" }) } },
    }
    const kept = prune(event, TAB_FIELDS["Network.requestWillBeSent"]!)
    expect(kept).toEqual({
      requestId: "req-2",
      type: "XHR",
      request: { method: "POST", url: "https://example.com/answer" },
    })
  })

  test("a missing field is left out rather than invented", () => {
    const { prune } = loadRelay()
    expect(prune({ requestId: "req-3" }, TAB_FIELDS["Network.loadingFailed"]!)).toEqual({ requestId: "req-3" })
    expect(prune({}, ["response.status"])).toEqual({})
    expect(prune({ response: null }, ["response.status"])).toEqual({})
  })

  test("every pruned event is one the extension is asked to relay", () => {
    const relayed: readonly string[] = TAB_EVENTS
    for (const method of Object.keys(TAB_FIELDS)) expect(relayed).toContain(method)
  })
})
