/**
 * OpenCode Browser Bridge — service worker.
 *
 * This is the browser half of driving the user's *real* browser from OpenCode.
 * OpenCode cannot open a debugging port on a browser the person is already
 * using with their profile, so instead this extension attaches the DevTools
 * protocol to tabs through `chrome.debugger` — the sanctioned way for an
 * extension to do it — and relays that protocol to OpenCode over a WebSocket.
 *
 * The wire is deliberately thin: OpenCode sends CDP methods, this forwards them
 * to `chrome.debugger.sendCommand`, and CDP events go back the other way. So
 * the engine's existing CDP vocabulary (Input.dispatchMouseEvent,
 * Runtime.evaluate, Page.captureScreenshot, Page.startScreencast…) works
 * unchanged; only the transport is different.
 *
 * Nothing here forges anything. It is a real browser, reporting itself
 * honestly; it gets where the person's own browsing gets, because it *is* their
 * browsing, with the agent issuing the clicks.
 *
 * Protocol (JSON per WebSocket message):
 *   ext  → server  { type: "auth", token }
 *   ext  → server  { id, type: "result", result }        reply to a request
 *   ext  → server  { id, type: "error", error }          reply to a request
 *   ext  → server  { type: "event", targetId, method, params }   forwarded CDP event
 *   ext  → server  { type: "target", event, target }     tab lifecycle
 *   ext  → server  { type: "detached", targetId, reason } debugger detached
 *   server → ext   { id, type: "listTargets" }
 *   server → ext   { id, type: "attach", targetId, events?, fields? }
 *                  events: CDP events to relay (all when absent)
 *                  fields: per event, the fields to keep (whole event when absent)
 *   server → ext   { id, type: "detach", targetId }
 *   server → ext   { id, type: "command", targetId, method, params }
 *   server → ext   { id, type: "createTarget", url }
 *   server → ext   { id, type: "activateTarget", targetId }
 *   server → ext   { id, type: "closeTarget", targetId }
 *   server → ext   { id, type: "goBack", targetId }         history back, without the debugger
 *
 * A `targetId` is the Chrome tab id as a string. The engine treats it as opaque.
 */

const DEFAULT_PORT = 4919
/** CDP version chrome.debugger requires. */
const PROTOCOL = "1.3"
/** Reconnect backoff, capped. */
const RETRY_MIN = 1000
const RETRY_MAX = 15000
/** MV3 kills an idle service worker; a ping while connected keeps it and the socket alive. */
const PING_MS = 20000

let socket
let retry = RETRY_MIN
let pingTimer
/** Tabs this extension has attached the debugger to. */
const attached = new Set()
/**
 * Per tab, the CDP events OpenCode asked for. A busy page emits far more than
 * it reads (Network.dataReceived and the like), and relaying those would queue
 * them in front of command replies on the one socket.
 */
const wanted = new Map()
/**
 * Per tab, the fields OpenCode reads from each event, by event name. One
 * `Network.responseReceived` carries every header, the timing breakdown and
 * the TLS certificate chain; relaying an ordinary news site in full was 1.1 MB
 * of events in twelve seconds, ahead of the clicks waiting on the same socket.
 * OpenCode sends this table when it attaches, so what to keep is decided there,
 * in `protocol.ts`, not here. An event with no entry is relayed whole.
 */
const shapes = new Map()

/**
 * A copy of `params` holding only `paths` ("response.status" and the like).
 *
 * A path the event does not have is left out rather than filled in, so what
 * arrives on the other side looks exactly like an event that never carried it.
 */
function prune(params, paths) {
  const out = {}
  for (const path of paths) {
    const parts = String(path).split(".")
    let from = params
    let depth = 0
    for (; depth < parts.length - 1; depth++) {
      if (from === null || typeof from !== "object" || !(parts[depth] in from)) break
      from = from[parts[depth]]
    }
    if (depth !== parts.length - 1) continue
    if (from === null || typeof from !== "object") continue
    const leaf = parts[depth]
    if (!(leaf in from)) continue
    let to = out
    for (let index = 0; index < parts.length - 1; index++) {
      const key = parts[index]
      if (typeof to[key] !== "object" || to[key] === null) to[key] = {}
      to = to[key]
    }
    to[leaf] = from[leaf]
  }
  return out
}

async function config() {
  const stored = await chrome.storage.local.get(["port", "token"])
  return { port: stored.port || DEFAULT_PORT, token: stored.token || "" }
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function reply(id, result) {
  send({ id, type: "result", result: result ?? {} })
}

function fail(id, error) {
  send({ id, type: "error", error: String(error && error.message ? error.message : error) })
}

/** The tab id behind a target id, or throws a message the agent can read. */
function tabIdOf(targetId) {
  const id = Number(targetId)
  if (!Number.isInteger(id)) throw new Error(`Unknown target ${targetId}`)
  return id
}

/** Tabs being detached on purpose to attach again, whose detach OpenCode must not hear about. */
const reattaching = new Set()

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL)
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    if (!/already attached/i.test(message)) throw error
    // The browser restarts this service worker when it likes, and the new one
    // forgets which tabs the old one attached to; the browser does not. Detach
    // what is ours and attach afresh. If the detach fails the debugger is
    // someone else's, such as DevTools open on the tab.
    reattaching.add(tabId)
    try {
      await chrome.debugger.detach({ tabId })
    } catch {
      reattaching.delete(tabId)
      throw new Error(`${message} DevTools or another extension is debugging this tab; close it there and try again.`)
    }
    await chrome.debugger.attach({ tabId }, PROTOCOL)
  }
  attached.add(tabId)
}

async function detach(tabId) {
  wanted.delete(tabId)
  shapes.delete(tabId)
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // Already gone; nothing to release.
  }
}

async function listTargets() {
  const tabs = await chrome.tabs.query({})
  return tabs
    .filter((tab) => typeof tab.id === "number" && /^https?:|^file:|^about:/.test(tab.url || ""))
    .map((tab) => ({
      targetId: String(tab.id),
      url: tab.url || "",
      title: tab.title || "",
      active: tab.active === true,
    }))
}

async function handle(message) {
  const { id, type } = message
  try {
    switch (type) {
      case "listTargets":
        return reply(id, { targets: await listTargets() })
      case "attach": {
        const tabId = tabIdOf(message.targetId)
        if (Array.isArray(message.events)) wanted.set(tabId, new Set(message.events))
        else wanted.delete(tabId)
        if (message.fields && typeof message.fields === "object") shapes.set(tabId, message.fields)
        else shapes.delete(tabId)
        await ensureAttached(tabId)
        return reply(id, {})
      }
      case "detach": {
        await detach(tabIdOf(message.targetId))
        return reply(id, {})
      }
      case "command": {
        const tabId = tabIdOf(message.targetId)
        await ensureAttached(tabId)
        const result = await chrome.debugger.sendCommand({ tabId }, message.method, message.params || {})
        return reply(id, result ?? {})
      }
      case "createTarget": {
        const tab = await chrome.tabs.create({ url: message.url || "about:blank", active: true })
        return reply(id, { targetId: String(tab.id) })
      }
      case "activateTarget": {
        const tabId = tabIdOf(message.targetId)
        const tab = await chrome.tabs.get(tabId)
        await chrome.tabs.update(tabId, { active: true })
        if (typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true })
        return reply(id, {})
      }
      case "closeTarget": {
        const tabId = tabIdOf(message.targetId)
        await detach(tabId)
        await chrome.tabs.remove(tabId)
        return reply(id, {})
      }
      case "goBack": {
        // Needs no debugger, so it also rescues a tab the debugger was thrown
        // off, such as one that opened a PDF in the browser's own viewer.
        await chrome.tabs.goBack(tabIdOf(message.targetId))
        return reply(id, {})
      }
      default:
        return fail(id, `Unknown request type ${type}`)
    }
  } catch (error) {
    if (id !== undefined) fail(id, error)
  }
}

function connect() {
  void config().then(({ port, token }) => {
    if (!token) return // Not paired yet; the popup sets port + token.
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}/experimental/browser/extension`)
    } catch {
      scheduleReconnect()
      return
    }

    socket.addEventListener("open", () => {
      retry = RETRY_MIN
      send({ type: "auth", token })
      clearInterval(pingTimer)
      pingTimer = setInterval(() => send({ type: "ping" }), PING_MS)
    })
    socket.addEventListener("message", (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message && message.type) void handle(message)
    })
    socket.addEventListener("close", () => {
      clearInterval(pingTimer)
      socket = undefined
      scheduleReconnect()
    })
    socket.addEventListener("error", () => {
      try {
        socket && socket.close()
      } catch {}
    })
  })
}

function scheduleReconnect() {
  setTimeout(connect, retry)
  retry = Math.min(retry * 2, RETRY_MAX)
}

// CDP events from any attached tab go to OpenCode, if it asked for them.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return
  const filter = wanted.get(source.tabId)
  if (filter && !filter.has(method)) return
  const fields = shapes.get(source.tabId)
  const keep = fields && Array.isArray(fields[method]) ? fields[method] : undefined
  const payload = params || {}
  send({ type: "event", targetId: String(source.tabId), method, params: keep ? prune(payload, keep) : payload })
})

// The debugger can be dropped by the user, by DevTools opening, or by the tab
// closing; OpenCode needs to know the tab is no longer driveable.
chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId !== "number") return
  if (reattaching.delete(source.tabId)) return
  attached.delete(source.tabId)
  wanted.delete(source.tabId)
  shapes.delete(source.tabId)
  send({ type: "detached", targetId: String(source.tabId), reason })
})

// Tab lifecycle, so OpenCode's tab list and the live panel stay current.
chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id === "number")
    send({
      type: "target",
      event: "created",
      target: { targetId: String(tab.id), url: tab.url || "", title: tab.title || "", active: !!tab.active },
    })
})
chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
  send({
    type: "target",
    event: "updated",
    target: { targetId: String(tabId), url: tab.url || "", title: tab.title || "", active: !!tab.active },
  })
})
chrome.tabs.onActivated.addListener((info) => {
  send({ type: "target", event: "activated", target: { targetId: String(info.tabId) } })
})
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId)
  wanted.delete(tabId)
  shapes.delete(tabId)
  send({ type: "target", event: "removed", target: { targetId: String(tabId) } })
})

// The popup asks whether the socket is currently open.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message && message.type === "status") {
    respond(!!socket && socket.readyState === WebSocket.OPEN)
    return true
  }
  return false
})

// Reconnect whenever the pairing changes from the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return
  if (changes.port || changes.token) {
    try {
      socket && socket.close()
    } catch {}
    retry = RETRY_MIN
    connect()
  }
})

chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()
