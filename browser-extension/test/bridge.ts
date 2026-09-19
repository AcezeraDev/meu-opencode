/**
 * Standalone test bridge for the OpenCode Browser Bridge extension.
 *
 * This stands in for the OpenCode server so the extension (half A) can be
 * proven on its own, before the engine is wired up (half B). Run it, pair the
 * extension's popup to the printed port and token, and it will:
 *   1. list the browser's tabs,
 *   2. attach to the active one,
 *   3. read navigator.userAgent and navigator.webdriver (the open question:
 *      is a chrome.debugger-driven tab flagged as automated?),
 *   4. open example.com and screenshot it to ./bridge-shot.png.
 *
 * The `Bridge` class here is also the reference for half B: the engine's
 * BridgeConnection has to offer the same request/response-by-id and event
 * plumbing, but shaped to the CDPConnection interface in
 * packages/opencode/src/browser/cdp.ts.
 *
 * Run:  bun browser-extension/test/bridge.ts
 */

import { randomBytes } from "crypto"
import fs from "fs"
import path from "path"

const PORT = Number(process.env.PORT) || 4919
const TOKEN = process.env.TOKEN || randomBytes(8).toString("hex")

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

/** One paired extension connection, exposing CDP over the relay. */
class Bridge {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private handlers = new Map<string, Set<(params: any) => void>>()

  constructor(private socket: import("bun").ServerWebSocket<unknown>) {}

  receive(raw: string) {
    let message: any
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.type === "result" || message.type === "error") {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.type === "error") waiter.reject(new Error(message.error))
      else waiter.resolve(message.result ?? {})
      return
    }
    if (message.type === "event") {
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {})
    }
  }

  private request(type: string, extra: Record<string, unknown> = {}) {
    const id = this.nextId++
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${type} timed out`))
      }, 60000)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
    })
    this.socket.send(JSON.stringify({ id, type, ...extra }))
    return promise
  }

  listTargets() {
    return this.request("listTargets").then((r) => r.targets as any[])
  }
  attach(targetId: string) {
    return this.request("attach", { targetId })
  }
  createTarget(url: string) {
    return this.request("createTarget", { url }).then((r) => r.targetId as string)
  }
  command<T = any>(targetId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.request("command", { targetId, method, params })
  }

  on(method: string, handler: (params: any) => void) {
    let set = this.handlers.get(method)
    if (!set) this.handlers.set(method, (set = new Set()))
    set.add(handler)
  }
}

let bridge: Bridge | undefined

async function drive(b: Bridge) {
  console.log("[bridge] extension paired; driving a demo...")
  const targets = await b.listTargets()
  console.log("[bridge] tabs:", targets.map((t) => `${t.targetId} ${t.active ? "*" : " "} ${t.url}`).join("\n            "))
  const active = targets.find((t) => t.active) ?? targets[0]
  if (!active) return console.log("[bridge] no drivable tab open")

  await b.attach(active.targetId)
  await b.command(active.targetId, "Runtime.enable")
  await b.command(active.targetId, "Page.enable")

  const fp = await b.command(active.targetId, "Runtime.evaluate", {
    expression: `({ ua: navigator.userAgent, webdriver: navigator.webdriver, brave: typeof navigator.brave })`,
    returnByValue: true,
  })
  console.log("[bridge] fingerprint:", JSON.stringify(fp.result?.value))

  const target = await b.createTarget("https://example.com/")
  await b.attach(target)
  await b.command(target, "Page.enable")
  await new Promise((r) => setTimeout(r, 2500))
  const shot = await b.command(target, "Page.captureScreenshot", { format: "png" })
  const out = path.join(import.meta.dir, "bridge-shot.png")
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"))
  console.log("[bridge] screenshot saved to", out)
  console.log("[bridge] done. Leave running or Ctrl+C.")
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req, server) {
    if (new URL(req.url).pathname === "/experimental/browser/extension" && server.upgrade(req)) return
    return new Response("OpenCode test bridge", { status: 200 })
  },
  websocket: {
    message(ws, raw) {
      const text = String(raw)
      let message: any
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (message.type === "auth") {
        if (message.token !== TOKEN) {
          console.log("[bridge] rejected: wrong token")
          ws.close()
          return
        }
        bridge = new Bridge(ws)
        void drive(bridge).catch((e) => console.error("[bridge] error:", e.message))
        return
      }
      if (message.type === "ping") return
      bridge?.receive(text)
    },
    close() {
      console.log("[bridge] extension disconnected")
      bridge = undefined
    },
  },
})

console.log("=".repeat(56))
console.log(" OpenCode test bridge listening")
console.log(`   Port:  ${PORT}`)
console.log(`   Token: ${TOKEN}`)
console.log(" Open the extension popup, enter these, Salvar e conectar.")
console.log("=".repeat(56))
