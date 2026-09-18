/**
 * A minimal Chrome DevTools Protocol client.
 *
 * Playwright would be the obvious choice here, but its WebSocket client hangs
 * under Bun on Windows, and opencode runs on Bun both in the CLI and in the
 * compiled binary. The platform WebSocket, which Bun and Node both provide,
 * talks to Chromium's debugging endpoint without trouble, so the browser is
 * driven directly. The bonus is no heavyweight dependency to bundle and no
 * browser download: any installed Chromium-based browser works.
 */

export interface CDPEvent {
  method: string
  params: Record<string, unknown>
}

type Handler = (params: Record<string, unknown>) => void

export class CDPError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`)
    this.name = "CDPError"
  }
}

const CONNECT_TIMEOUT = 20_000
const CALL_TIMEOUT = 60_000

export class CDPConnection {
  private socket?: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private handlers = new Map<string, Set<Handler>>()
  private closed = false

  constructor(readonly url: string) {}

  async connect() {
    const socket = new WebSocket(this.url)
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.url}`)), CONNECT_TIMEOUT)
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer)
          reject(new Error(`Failed to connect to ${this.url}`))
        },
        { once: true },
      )
    })

    socket.addEventListener("message", (event) => this.receive(String(event.data)))
    socket.addEventListener("close", () => this.abort(new Error("Browser connection closed")))
  }

  private receive(raw: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof parsed !== "object" || parsed === null) return
    const message = parsed as {
      id?: number
      error?: { message?: string }
      result?: unknown
      method?: string
      params?: Record<string, unknown>
    }

    if (typeof message.id === "number") {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? "CDP call failed"))
      else waiter.resolve(message.result ?? {})
      return
    }

    if (typeof message.method === "string") {
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {})
    }
  }

  private abort(error: Error) {
    this.closed = true
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed || !this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new CDPError(method, "not connected"))
    }
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CDPError(method, `timed out after ${CALL_TIMEOUT}ms`))
      }, CALL_TIMEOUT)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          // The caller names the result type it expects; the table itself holds
          // every in-flight call, so it cannot be typed per entry.
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(new CDPError(method, error.message))
        },
      })
    })
    this.socket.send(JSON.stringify({ id, method, params }))
    return promise
  }

  on(method: string, handler: Handler) {
    let set = this.handlers.get(method)
    if (!set) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }

  /** Resolves when `method` fires, or rejects once `timeout` passes. */
  once(method: string, timeout: number) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new CDPError(method, `event did not fire within ${timeout}ms`))
      }, timeout)
      const off = this.on(method, (params) => {
        clearTimeout(timer)
        off()
        resolve(params)
      })
    })
  }

  close() {
    this.closed = true
    try {
      this.socket?.close()
    } catch {
      // Already gone; nothing to release.
    }
    this.abort(new Error("Connection closed"))
  }

  get connected() {
    return !this.closed && this.socket?.readyState === 1
  }
}

export * as CDP from "./cdp"
