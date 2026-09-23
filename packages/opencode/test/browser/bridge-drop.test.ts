import fs from "fs/promises"
import path from "path"
import { afterAll, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Browser } from "@/browser/session"
import { BrowserBridge } from "@/browser/bridge"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { BrowserNavigateTool } from "../../src/tool/browser_navigate"
import { SessionID, MessageID } from "../../src/session/schema"
import { TestConfig } from "../fixture/config"
import { pollWithTimeout, testEffect } from "../lib/effect"

const TOKEN = "bridge-drop-token"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Browser.node, Truncate.node, Agent.node]), [
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

const ctx = {
  sessionID: SessionID.make("ses_bridge_drop"),
  messageID: MessageID.make("msg_bridge_drop"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

/**
 * An extension whose socket goes down while the first navigation is waiting,
 * as a restarted worker's does, and pairs again a moment later.
 */
function pairDroppingExtension() {
  BrowserBridge.reset()
  const bridge = BrowserBridge.instance()
  bridge.configure(TOKEN)
  const navigations: string[] = []
  let dropped = false
  const answer = (message: any) => {
    const reply = (result: unknown) => bridge.receive(JSON.stringify({ id: message.id, type: "result", result }))
    if (message.type === "listTargets")
      return reply({ targets: [{ targetId: "7", url: "https://example.com/", title: "Example", active: true }] })
    if (message.type !== "command") return reply({})
    if (message.method === "Page.navigate") {
      navigations.push(String(message.params?.url))
      if (!dropped) {
        dropped = true
        // Unanswered, then the socket is gone; the extension comes back shortly.
        link.disconnect()
        setTimeout(pair, 50)
        return
      }
    }
    if (message.method === "Page.getFrameTree") return reply({ frameTree: { frame: { id: "main" } } })
    if (message.method !== "Runtime.evaluate") return reply({})
    const expression = String(message.params?.expression ?? "")
    if (expression === "document.location.href") return reply({ result: { value: "https://example.com/aula" } })
    if (expression === "document.title") return reply({ result: { value: "Aula" } })
    return reply({ result: { value: true } })
  }
  let link: BrowserBridge.Link
  const pair = () => {
    link = bridge.accept(
      (message) => queueMicrotask(() => answer(message)),
      () => {},
    )
    link.receive(JSON.stringify({ type: "auth", token: TOKEN, previous: { reason: "worker-start" } }))
  }
  pair()
  return { navigations }
}

describe("the extension dropping out mid-navigation", () => {
  it.instance(
    "opens the address again once it is back, and the log says what was waiting",
    () =>
      Effect.gen(function* () {
        const { navigations } = pairDroppingExtension()
        const navigate = yield* (yield* BrowserNavigateTool).init()

        const result = yield* navigate.execute({ url: "https://example.com/aula", snapshot: false }, ctx)
        expect(result.output).toContain("https://example.com/aula")
        expect(navigations).toEqual(["https://example.com/aula", "https://example.com/aula"])

        const file = path.join(Global.Path.log, "browser-bridge.log")
        const text = yield* pollWithTimeout(
          Effect.promise(() =>
            fs.readFile(file, "utf8").then(
              (content) => (content.includes("Page.navigate") ? content : undefined),
              () => undefined,
            ),
          ),
          "the bridge log never recorded the drop",
        )
        expect(text).toMatch(/disconnect .*Page\.navigate/)
        expect(text).toContain("worker-start")

        const browser = yield* Browser.Service
        yield* browser.shutdown()
      }),
    30_000,
  )
})
