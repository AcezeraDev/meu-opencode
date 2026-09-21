import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

export type BrowserTab = { id: string; url: string; title: string; active: boolean }
export type BrowserStatus = {
  running: boolean
  mode?: "process" | "extension"
  browser?: string
  headless: boolean
  url?: string
  title?: string
  tabs: BrowserTab[]
  /** The person's own browser, where the current page can be handed over. Absent means the system default. */
  external?: string
}
export type BrowserActivity = { kind: string; target?: string; tab: string; at: number }
/** A JPEG as base64, with the viewport it shows in CSS pixels. */
export type BrowserFrame = { data: string; width: number; height: number }

export type BrowserCommand =
  | { action: "navigate"; url: string }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "new_tab"; url?: string }
  | { action: "select_tab"; tab: string }
  | { action: "close_tab"; tab: string }
  | { action: "resize"; width: number; height: number }
  | { action: "open_external" }

export type BrowserInput =
  | {
      type: "mouse"
      action: "move" | "down" | "up"
      x: number
      y: number
      button?: "left" | "middle" | "right" | "none"
      buttons?: number
      clickCount?: number
      modifiers?: number
    }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | {
      type: "key"
      action: "down" | "up"
      key: string
      code: string
      keyCode: number
      text?: string
      modifiers?: number
    }
  | { type: "text"; text: string }

type ServerEvent =
  | { type: "status"; status: BrowserStatus }
  | { type: "frame"; frame: BrowserFrame }
  | { type: "activity"; activity: BrowserActivity }
  | { type: "heartbeat" }

/** How long to wait before reconnecting a dropped stream. */
const RETRY_MS = 1500

/**
 * The payload of one server-sent event.
 *
 * Nearly every event is a single `data:` line, which gets its own path:
 * splitting a frame's few hundred kilobytes into lines only to join them back
 * costs more than the event it carries.
 */
function eventData(chunk: string) {
  if (chunk.startsWith("data:") && !chunk.includes("\n")) return chunk.slice(5).trimStart()
  return chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
}

/**
 * The live connection to the server's browser.
 *
 * While `enabled` it holds an SSE stream open: status and agent activity land
 * in signals, and frames go to whoever registered for them, bypassing Solid
 * because they arrive many times a second and only a canvas cares. Input and
 * toolbar commands go the other way over plain POSTs.
 */
export function createBrowserFeed(input: { directory: Accessor<string | undefined>; enabled: Accessor<boolean> }) {
  const server = useServer()
  const platform = usePlatform()
  const fetcher = platform.fetch ?? fetch

  const [status, setStatus] = createSignal<BrowserStatus>()
  const [activity, setActivity] = createSignal<BrowserActivity>()
  const [connected, setConnected] = createSignal(false)
  const frameListeners = new Set<(frame: BrowserFrame) => void>()

  const endpoint = (path: string) => {
    const connection = server.current
    if (!connection) return undefined
    const url = new URL(`/experimental/browser/${path}`, connection.http.url)
    const dir = input.directory()
    if (dir) url.searchParams.set("directory", dir)
    const headers: Record<string, string> = {}
    if (connection.http.password) {
      headers.Authorization = `Basic ${authTokenFromCredentials({
        username: connection.http.username,
        password: connection.http.password,
      })}`
    }
    return { url, headers }
  }

  const handle = (event: ServerEvent) => {
    if (event.type === "status") setStatus(event.status)
    else if (event.type === "activity") setActivity(event.activity)
    else if (event.type === "frame") for (const listener of frameListeners) listener(event.frame)
  }

  createEffect(() => {
    if (!input.enabled()) return
    input.directory()
    const abort = new AbortController()
    let stopped = false

    const run = async () => {
      while (!stopped) {
        try {
          const target = endpoint("stream")
          if (!target) throw new Error("No server connection")
          const response = await fetcher(target.url, { headers: target.headers, signal: abort.signal })
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
          setConnected(true)
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
          let buffer = ""
          // Where the search for the next event's end left off. A frame is a
          // few hundred kilobytes and arrives in pieces, so starting the search
          // at the front on every piece would read the same text over and over.
          let scanned = 0
          while (!stopped) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += value
            let boundary = buffer.indexOf("\n\n", scanned)
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              scanned = 0
              const data = eventData(chunk)
              if (data) {
                try {
                  handle(JSON.parse(data) as ServerEvent)
                } catch {
                  // A malformed event is skipped, not fatal.
                }
              }
              boundary = buffer.indexOf("\n\n")
            }
            // A boundary is two characters, so only the last one can be split
            // across the pieces still to come.
            scanned = Math.max(0, buffer.length - 1)
          }
        } catch {
          // Dropped or refused; retried below unless the view went away.
        }
        setConnected(false)
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
      }
    }
    void run()

    onCleanup(() => {
      stopped = true
      abort.abort()
      setConnected(false)
    })
  })

  const post = async (path: string, body: unknown) => {
    const target = endpoint(path)
    if (!target) return undefined
    const response = await fetcher(target.url, {
      method: "POST",
      headers: { ...target.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) return undefined
    return response.json()
  }

  /**
   * Input is sent one event at a time, in order: a mouse-up overtaking its
   * mouse-down on a parallel request would break the click. Moves that pile up
   * behind a slow request collapse into the latest one.
   */
  const queue: BrowserInput[] = []
  let draining = false
  const drain = async () => {
    if (draining) return
    draining = true
    while (queue.length > 0) {
      const next = queue.shift()!
      await post("input", next).catch(() => undefined)
    }
    draining = false
  }

  return {
    status,
    activity,
    connected,
    /** The server's port, shown so the extension can be paired to it. */
    serverPort() {
      const url = server.current?.http.url
      if (!url) return undefined
      try {
        const parsed = new URL(url)
        return parsed.port || (parsed.protocol === "https:" ? "443" : "80")
      } catch {
        return undefined
      }
    },
    onFrame(listener: (frame: BrowserFrame) => void) {
      frameListeners.add(listener)
      return () => frameListeners.delete(listener)
    },
    async control(command: BrowserCommand) {
      const next = (await post("control", command).catch(() => undefined)) as BrowserStatus | undefined
      if (next) setStatus(next)
      return next
    },
    input(event: BrowserInput) {
      const last = queue.at(-1)
      if (event.type === "mouse" && event.action === "move" && last?.type === "mouse" && last.action === "move") {
        queue[queue.length - 1] = event
      } else queue.push(event)
      void drain()
    },
  }
}

export type BrowserFeed = ReturnType<typeof createBrowserFeed>
