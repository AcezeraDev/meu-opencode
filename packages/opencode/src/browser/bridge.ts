import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { CDPError, type CDPTransport } from "./cdp"
import { TAB_EVENTS, TAB_FIELDS } from "./protocol"

/**
 * The OpenCode side of the browser extension.
 *
 * The extension (see the `browser-extension/` folder) drives the person's own
 * browser through `chrome.debugger` and relays the DevTools protocol here over a
 * WebSocket. This holds that one connection and turns it back into the same
 * transport a {@link Tab} expects, so the browser tools work against the real
 * browser with only the transport changed.
 *
 * The wire protocol is described in `browser-extension/background.js`.
 */

type Handler = (params: Record<string, unknown>) => void

export interface BridgeTarget {
  targetId: string
  url: string
  title: string
  active: boolean
}

/** A tab lifecycle change reported by the extension. */
export interface TargetEvent {
  event: "created" | "updated" | "activated" | "removed"
  target: { targetId: string; url?: string; title?: string; active?: boolean }
}

/**
 * A command the browser has not answered in this long is stuck, most often on
 * a frozen page; waiting a minute per call only multiplies the wait.
 */
const CALL_TIMEOUT = 30_000

/**
 * How long a command waits for an extension that is not connected this moment.
 * The extension retries after a second and backs off from there, so this covers
 * a few attempts without leaving the agent hanging on a browser that is gone.
 */
const RECONNECT_WAIT = 5000

/**
 * Whether a failed command is one that re-attaching the debugger to the tab
 * could fix: the extension's worker restarted, or the tab was detached without
 * the event reaching us yet. A one-shot retry after a fresh attach clears these
 * where a bare failure would cost the agent a whole step.
 */
function isReattachable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  // Only the debugger's own attachment errors, never a page's benign ones (a
  // cross-origin frame read, an evaluate that raced a navigation): matching
  // those would re-attach and retry on ordinary calls and slow everything down.
  return /Debugger is not attached|is already attached|No tab with given id|No target with given id|Detached while handling command/i.test(
    message,
  )
}

/**
 * One tab's slice of the relay, shaped like a {@link CDPTransport} so a Tab
 * cannot tell it apart from a direct DevTools socket.
 */
class BridgeConnection implements CDPTransport {
  private handlers = new Map<string, Set<Handler>>()
  private closed = false
  /** Pending `once` waits, failed at once when the tab is lost rather than left to time out. */
  private waiters = new Set<(error: Error) => void>()

  constructor(
    private bridge: Bridge,
    readonly targetId: string,
  ) {}

  /**
   * Attaches the extension's debugger to this tab, so its events start flowing.
   * Only the events a tab listens to are asked for, and of those only the
   * fields it reads; the rest would just crowd the socket that command replies
   * also travel on.
   */
  async connect() {
    await this.bridge.request("attach", { targetId: this.targetId, events: TAB_EVENTS, fields: TAB_FIELDS })
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new CDPError(method, "not connected")
    // An extension whose service worker was put to sleep takes its socket down
    // with it and comes back on its own a second later. Failing the command
    // outright made the agent spend a whole step on an error it could do
    // nothing about — 19 of them across the sessions measured — so a command
    // that arrives in that gap waits for the extension instead, and reattaches
    // to this tab before going out, since the debugger went down with it.
    if (!this.bridge.connected) {
      await this.bridge.whenConnected(RECONNECT_WAIT).catch(() => {
        throw new CDPError(method, "not connected")
      })
      if (this.closed) throw new CDPError(method, "not connected")
      await this.connect()
    }
    try {
      return await this.bridge.request<T>("command", { targetId: this.targetId, method, params })
    } catch (error) {
      // The extension lost the debugger for this tab — its service worker
      // restarted, or the tab was detached (a PDF viewer, a chrome page) and
      // the event that says so has not arrived yet — so the command bounced off
      // a tab it thinks is unattached. Re-attaching and trying once more is
      // exactly what a person clicking again would get, instead of a dead step.
      if (this.closed || !isReattachable(error)) throw error
      if (!this.bridge.connected)
        await this.bridge.whenConnected(RECONNECT_WAIT).catch(() => {
          throw error
        })
      await this.connect()
      return this.bridge.request<T>("command", { targetId: this.targetId, method, params })
    }
  }

  on(method: string, handler: Handler) {
    let set = this.handlers.get(method)
    if (!set) this.handlers.set(method, (set = new Set()))
    set.add(handler)
    return () => set!.delete(handler)
  }

  once(method: string, timeout: number) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.closed) return reject(new CDPError(method, "not connected"))
      const settle = () => {
        clearTimeout(timer)
        off()
        this.waiters.delete(fail)
      }
      const fail = (error: Error) => {
        settle()
        reject(error)
      }
      const timer = setTimeout(() => fail(new CDPError(method, `event did not fire within ${timeout}ms`)), timeout)
      const off = this.on(method, (params) => {
        settle()
        resolve(params)
      })
      this.waiters.add(fail)
    })
  }

  /** Stops for good: no more events, pending waits fail, and the bridge forgets this tab's transport. */
  private end() {
    this.closed = true
    this.handlers.clear()
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const fail of waiters) fail(new CDPError("tab", "not connected"))
    this.bridge.release(this.targetId, this)
  }

  close() {
    if (this.closed) return
    this.end()
    // Let the browser drop the debugger banner; failure is fine, the tab may be gone.
    if (this.bridge.connected) void this.bridge.request("detach", { targetId: this.targetId }).catch(() => {})
  }

  get connected() {
    return !this.closed && this.bridge.connected
  }

  /** Fed by the Bridge when a CDP event arrives for this tab. */
  dispatch(method: string, params: Record<string, unknown>) {
    for (const handler of this.handlers.get(method) ?? []) handler(params)
  }

  /**
   * The extension dropped the debugger on this tab, as the browser does when
   * the tab moves to a page extensions may not drive, like its PDF viewer.
   * Behave as closed, and let the bridge forget this transport, so attaching
   * to the tab again starts a fresh one instead of reusing a dead one.
   */
  drop() {
    if (this.closed) return
    this.end()
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Holds the single extension connection and multiplexes it: requests are
 * matched to replies by id, CDP events are routed to the right tab's
 * {@link BridgeConnection}, and tab lifecycle is handed to whoever is listening.
 */
export class Bridge {
  private write?: (message: object) => void
  private disconnectSocket?: () => void
  private authed = false
  private nextId = 1
  private pending = new Map<number, Pending>()
  private connections = new Map<string, BridgeConnection>()
  private targetListeners = new Set<(event: TargetEvent) => void>()
  private stateListeners = new Set<() => void>()

  constructor(private token: string) {}

  /** Sets the shared secret an extension must send. Takes effect on the next pairing. */
  configure(token: string) {
    this.token = token
  }

  get connected() {
    return this.authed && this.write !== undefined
  }

  /** Whether a token has been set; without one the bridge refuses every extension. */
  get paired() {
    return this.token.length > 0
  }

  /**
   * Takes over a freshly opened extension socket. `write` sends one JSON
   * message; `close` drops the socket. The socket is not trusted until it sends
   * the right token.
   */
  accept(write: (message: object) => void, close: () => void) {
    // Only one extension at a time; a new one replaces the old.
    this.reset()
    this.write = write
    this.disconnectSocket = close
    this.authed = false
  }

  /** Feeds one raw message from the extension. */
  receive(raw: string) {
    let message: {
      id?: number
      type?: string
      token?: string
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: string
      targetId?: string
      event?: TargetEvent["event"]
      target?: TargetEvent["target"]
      reason?: string
    }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.type === "auth") {
      if (message.token !== this.token) {
        this.disconnectSocket?.()
        return
      }
      this.authed = true
      this.emitState()
      return
    }
    if (!this.authed) return
    switch (message.type) {
      case "ping":
        return
      case "result":
      case "error": {
        if (typeof message.id !== "number") return
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.type === "error") waiter.reject(new Error(message.error ?? "extension call failed"))
        else waiter.resolve(message.result ?? {})
        return
      }
      case "event":
        if (message.targetId && message.method) {
          this.connections.get(message.targetId)?.dispatch(message.method, message.params ?? {})
        }
        return
      case "detached":
        if (message.targetId) this.connections.get(message.targetId)?.drop()
        return
      case "target":
        if (message.event && message.target) {
          const detail: TargetEvent = { event: message.event, target: message.target }
          if (detail.event === "removed") this.connections.get(detail.target.targetId)?.drop()
          for (const listener of this.targetListeners) listener(detail)
        }
        return
    }
  }

  /** The socket closed. Every in-flight call fails and tabs go stale. */
  disconnect() {
    this.reset()
    this.emitState()
  }

  private reset() {
    this.write = undefined
    this.disconnectSocket = undefined
    this.authed = false
    for (const waiter of this.pending.values()) waiter.reject(new Error("browser extension disconnected"))
    this.pending.clear()
    for (const connection of this.connections.values()) connection.drop()
    this.connections.clear()
  }

  request<T = unknown>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
    const write = this.write
    if (!write || !this.authed) return Promise.reject(new CDPError(type, "extension not connected"))
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const method = typeof extra["method"] === "string" ? extra["method"] : type
        reject(
          new CDPError(
            method,
            `the browser did not answer within ${CALL_TIMEOUT / 1000}s. The page may be frozen or busy; wait a moment and try once more, or reload it with browser_navigate.`,
          ),
        )
      }, CALL_TIMEOUT)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
    write({ id, type, ...extra })
    return promise
  }

  async listTargets(): Promise<BridgeTarget[]> {
    const result = await this.request<{ targets?: BridgeTarget[] }>("listTargets")
    return result.targets ?? []
  }

  async createTarget(url: string): Promise<string> {
    const result = await this.request<{ targetId: string }>("createTarget", { url })
    return result.targetId
  }

  activateTarget(targetId: string): Promise<unknown> {
    return this.request("activateTarget", { targetId })
  }

  closeTarget(targetId: string): Promise<unknown> {
    return this.request("closeTarget", { targetId })
  }

  /**
   * Takes a tab back one page in its history. It needs no debugger, so it
   * works on a tab the debugger was thrown off, such as one showing a PDF.
   */
  goBack(targetId: string): Promise<unknown> {
    return this.request("goBack", { targetId })
  }

  /** The transport for one tab, reused while it lives; a lost one is replaced. */
  connection(targetId: string): CDPTransport {
    let connection = this.connections.get(targetId)
    if (!connection || !connection.connected) {
      this.connections.set(targetId, (connection = new BridgeConnection(this, targetId)))
    }
    return connection
  }

  /** Forgets a tab's transport, unless it has already been replaced by a newer one. */
  release(targetId: string, connection?: BridgeConnection) {
    if (!connection || this.connections.get(targetId) === connection) this.connections.delete(targetId)
  }

  onTarget(listener: (event: TargetEvent) => void) {
    this.targetListeners.add(listener)
    return () => this.targetListeners.delete(listener)
  }

  onState(listener: () => void) {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Resolves once an extension is connected, or rejects if none arrives in `timeout`. */
  whenConnected(timeout: number) {
    if (this.connected) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer)
        off()
      }
      const timer = setTimeout(() => {
        settle()
        reject(new Error("the browser extension did not reconnect"))
      }, timeout)
      const off = this.onState(() => {
        if (!this.connected) return
        settle()
        resolve()
      })
    })
  }

  private emitState() {
    for (const listener of this.stateListeners) listener()
  }
}

/**
 * The one bridge for this whole server process.
 *
 * A machine has a single real browser, so one extension drives it for every
 * session, whatever directory they are in. It lives at module scope rather than
 * per instance, and outlives any one session. The token seeds from the
 * environment so the extension can pair before any session touches the browser.
 */
let shared: Bridge | undefined

export function instance(): Bridge {
  if (!shared) shared = new Bridge(process.env["OPENCODE_BROWSER_EXTENSION_TOKEN"] ?? "")
  return shared
}

/** Test hook: forget the process bridge so a case starts from nothing. */
export function reset() {
  shared = undefined
}

export interface Interface {
  readonly get: () => Effect.Effect<Bridge>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BrowserBridge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    return Service.of({
      get: () =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const bridge = instance()
          // A shared secret so only the paired extension can drive the browser;
          // localhost-only, but a page in the browser could otherwise reach it.
          const token = cfg.browser?.extensionToken
          if (token) bridge.configure(token)
          return bridge
        }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node] })

export * as BrowserBridge from "./bridge"
