import { CDPConnection } from "./cdp"
import { BrowserCursor } from "./cursor"
import { BrowserSnapshot, type SnapshotOptions, type SnapshotResult } from "./snapshot"
import {
  asRecord,
  asText,
  type EvaluateResult,
  type LayoutMetrics,
  type NavigateResult,
  type NavigationHistory,
  type ScreenshotResult,
} from "./protocol"

export interface ConsoleEntry {
  type: string
  text: string
  time: number
}

export interface NetworkEntry {
  method: string
  url: string
  status?: number
  failure?: string
  time: number
}

export type WaitUntil = "load" | "domcontentloaded" | "networkidle"

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** What the agent is doing right now, for the live view's caption. */
export type ActivityKind =
  | "navigate"
  | "reload"
  | "back"
  | "forward"
  | "click"
  | "double_click"
  | "right_click"
  | "hover"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "scroll"
  | "wait"
  | "read"
  | "screenshot"
  | "inspect"

export interface Activity {
  kind: ActivityKind
  /** The element's accessible name, a URL or a key. Never a typed value. */
  target?: string
  tab: string
  at: number
}

/** One picture of the page. `width` and `height` are the viewport in CSS pixels. */
export interface Frame {
  data: string
  width: number
  height: number
}

/**
 * Input from the person watching the live view, in viewport CSS pixels. It is
 * forwarded as-is, so a user can sign in or steer a page the agent is on.
 */
export type UserInput =
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

/** How a tab reports to whoever owns it, and learns whether anyone is watching. */
export interface TabHooks {
  presenting(): boolean
  activity(activity: Activity): void
  changed(): void
}

const IDLE: TabHooks = { presenting: () => false, activity: () => {}, changed: () => {} }

const BUFFER_LIMIT = 300

/**
 * Pace while someone watches. Without an audience the agent acts at full speed;
 * with one, the cursor needs time to travel and a click needs a beat to land,
 * or the live view is a series of teleports.
 */
const GLIDE_MIN = 240
const GLIDE_MAX = 700
const GLIDE_PER_PIXEL = 0.5
const CLICK_SETTLE = 160
const TYPE_DELAY = 28
const TYPE_BUDGET = 2400
const SCROLL_SETTLE = 450

/** CDP wants a bitmask, and key events want a numeric code per key. */
const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 }
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
}

const MOUSE_EVENT = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const

function push<T>(buffer: T[], entry: T) {
  buffer.push(entry)
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function describeKey(name: string) {
  const parts = name.split("+")
  const last = parts.pop() ?? "Enter"
  let modifiers = 0
  for (const part of parts) modifiers |= MODIFIERS[part.toLowerCase()] ?? 0
  const known = KEYS[last.toLowerCase()]
  if (known) return { ...known, modifiers }
  if (last.length === 1) {
    const upper = last.toUpperCase()
    return {
      key: last,
      code: /[a-zA-Z]/.test(last) ? `Key${upper}` : `Digit${last}`,
      keyCode: upper.charCodeAt(0),
      // A modified key is a shortcut, not typed input, so it carries no text.
      text: modifiers === 0 ? last : undefined,
      modifiers,
    }
  }
  return { key: last, code: last, keyCode: 0, text: undefined, modifiers }
}

export class ElementNotFoundError extends Error {
  constructor(target: string) {
    super(
      `No element matches ${target} on the current page. Refs are renumbered whenever the page changes, so take a fresh browser_snapshot and use a ref from it.`,
    )
    this.name = "ElementNotFoundError"
  }
}

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EvaluationError"
  }
}

interface Target {
  rect: Rect
  name: string
}

/**
 * One browser tab, driven over CDP.
 *
 * Interactions go through real input events at the element's own coordinates
 * rather than synthetic DOM clicks, so sites that listen for pointer events, or
 * frameworks that ignore programmatic value assignment, behave as they would
 * for a person. What actually reaches the page is the same whether or not
 * anyone is watching; watching only adds the visible cursor and the pauses.
 */
export class Tab {
  readonly console: ConsoleEntry[] = []
  readonly network: NetworkEntry[] = []
  private inflight = new Set<string>()
  private requestIds = new Map<string, NetworkEntry>()
  /** Where the agent's pointer last was, in viewport CSS pixels. */
  private pointer = { x: 640, y: 400 }
  private stopCast?: () => void

  private constructor(
    readonly id: string,
    readonly targetId: string,
    private connection: CDPConnection,
    private hooks: TabHooks,
  ) {}

  static async attach(id: string, targetId: string, wsUrl: string, hooks: TabHooks = IDLE) {
    const connection = new CDPConnection(wsUrl)
    await connection.connect()
    const tab = new Tab(id, targetId, connection, hooks)
    await tab.prepare()
    return tab
  }

  private async prepare() {
    await Promise.all([
      this.connection.send("Page.enable"),
      this.connection.send("Runtime.enable"),
      this.connection.send("Network.enable"),
      this.connection.send("Log.enable").catch(() => {}),
    ])

    this.connection.on("Runtime.consoleAPICalled", (params) => {
      const args = Array.isArray(params["args"]) ? params["args"] : []
      const text = args
        .map((arg) => {
          const item = asRecord(arg)
          if (item["value"] !== undefined) return asText(item["value"], JSON.stringify(item["value"]))
          return asText(item["description"], asText(item["type"]))
        })
        .join(" ")
      push(this.console, { type: asText(params["type"], "log"), text, time: Date.now() })
    })

    this.connection.on("Runtime.exceptionThrown", (params) => {
      const details = asRecord(params["exceptionDetails"])
      const exception = asRecord(details["exception"])
      const text = asText(exception["description"], asText(details["text"], "Uncaught exception"))
      push(this.console, { type: "pageerror", text, time: Date.now() })
    })

    this.connection.on("Network.requestWillBeSent", (params) => {
      const request = asRecord(params["request"])
      const entry: NetworkEntry = {
        method: asText(request["method"], "GET"),
        url: asText(request["url"]),
        time: Date.now(),
      }
      const id = asText(params["requestId"])
      this.requestIds.set(id, entry)
      this.inflight.add(id)
      push(this.network, entry)
    })

    this.connection.on("Network.responseReceived", (params) => {
      const entry = this.requestIds.get(asText(params["requestId"]))
      const status = asRecord(params["response"])["status"]
      if (entry && typeof status === "number") entry.status = status
    })

    this.connection.on("Network.loadingFinished", (params) => {
      this.inflight.delete(asText(params["requestId"]))
    })

    this.connection.on("Network.loadingFailed", (params) => {
      const id = asText(params["requestId"])
      const entry = this.requestIds.get(id)
      if (entry) entry.failure = asText(params["errorText"], "failed")
      this.inflight.delete(id)
    })

    // The owner keeps its address bar and tab titles current from these.
    this.connection.on("Page.frameNavigated", (params) => {
      if (!asRecord(params["frame"])["parentId"]) this.hooks.changed()
    })
    this.connection.on("Page.loadEventFired", () => {
      this.hooks.changed()
      // A new document starts without the overlay; put the cursor back where
      // the agent left it so the view does not lose track of it.
      if (this.hooks.presenting()) void this.cursor("place", [this.pointer.x, this.pointer.y])
    })
  }

  get connected() {
    return this.connection.connected
  }

  /** Reports what the agent is doing to whoever is watching. */
  announce(kind: ActivityKind, target?: string) {
    this.hooks.activity({ kind, target: target || undefined, tab: this.id, at: Date.now() })
  }

  async url() {
    return this.evaluate<string>("document.location.href").catch(() => "about:blank")
  }

  async title() {
    return this.evaluate<string>("document.title").catch(() => "")
  }

  /** Evaluates an expression in the page and returns its value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.connection.send<EvaluateResult>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const details = result.exceptionDetails
      throw new EvaluationError(details.exception?.description ?? details.text ?? "Evaluation failed")
    }
    return result.result?.value as T
  }

  /** Calls an arrow-function source string with a JSON argument. */
  private call<T>(source: string, argument: unknown) {
    return this.evaluate<T>(`(${source})(${JSON.stringify(argument)})`)
  }

  /** Drives the in-page cursor overlay, installing it on first use. Never fails. */
  private cursor(method: string, args: number[], from = this.pointer) {
    const expression = `(${BrowserCursor.SCRIPT})(${from.x}, ${from.y}).${method}(${args.join(",")})`
    return this.evaluate(expression).catch(() => {})
  }

  snapshot(options: SnapshotOptions = {}) {
    return this.call<SnapshotResult>(BrowserSnapshot.SCRIPT, options)
  }

  text() {
    return this.call<{ url: string; title: string; text: string }>(BrowserSnapshot.TEXT_SCRIPT, {})
  }

  async html() {
    const result = await this.call<{ url: string; title: string; html: string }>(BrowserSnapshot.HTML_SCRIPT, {})
    // The overlay is ours, not the page's.
    const overlay = new RegExp(`<${BrowserCursor.HOST_TAG}[^>]*></${BrowserCursor.HOST_TAG}>`, "g")
    return { ...result, html: result.html.replace(overlay, "") }
  }

  async navigate(url: string, waitUntil: WaitUntil, timeout: number) {
    this.announce("navigate", url)
    const settled = this.waitForLoad(waitUntil, timeout)
    const result = await this.connection.send<NavigateResult>("Page.navigate", { url })
    if (result?.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`)
    await settled
  }

  async reload(waitUntil: WaitUntil, timeout: number) {
    this.announce("reload")
    const settled = this.waitForLoad(waitUntil, timeout)
    await this.connection.send("Page.reload")
    await settled
  }

  /** Moves `delta` entries through history; negative goes back. */
  async history(delta: number, waitUntil: WaitUntil, timeout: number) {
    const { currentIndex, entries } = await this.connection.send<NavigationHistory>("Page.getNavigationHistory")
    const index = currentIndex + delta
    if (index < 0 || index >= entries.length) {
      throw new Error(delta < 0 ? "No page to go back to." : "No page to go forward to.")
    }
    this.announce(delta < 0 ? "back" : "forward", entries[index].url)
    const settled = this.waitForLoad(waitUntil, timeout)
    await this.connection.send("Page.navigateToHistoryEntry", { entryId: entries[index].id })
    await settled
  }

  /**
   * Navigation from the person watching. It returns as soon as the navigation
   * starts, since the live view follows the page itself, and it is not reported
   * as the agent's doing.
   */
  async go(url: string) {
    const result = await this.connection.send<NavigateResult>("Page.navigate", { url })
    if (result?.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`)
  }

  async step(delta: number) {
    const { currentIndex, entries } = await this.connection.send<NavigationHistory>("Page.getNavigationHistory")
    const entry = entries[currentIndex + delta]
    if (entry) await this.connection.send("Page.navigateToHistoryEntry", { entryId: entry.id })
  }

  async refresh() {
    await this.connection.send("Page.reload")
  }

  /**
   * Waits for the page to settle. `networkidle` is the useful one for single
   * page apps, which often render after the load event.
   */
  async waitForLoad(waitUntil: WaitUntil, timeout: number) {
    const event = waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired"
    // A page that is already idle never fires the event again, so a timeout
    // here is a normal outcome rather than a failure.
    await this.connection.once(event, timeout).catch(() => {})
    if (waitUntil === "networkidle") await this.waitForIdle(timeout)
  }

  private async waitForIdle(timeout: number) {
    const deadline = Date.now() + timeout
    let quiet = 0
    while (Date.now() < deadline) {
      await sleep(100)
      if (this.inflight.size === 0) {
        quiet += 100
        if (quiet >= 500) return
      } else quiet = 0
    }
  }

  /**
   * Finds an element, scrolls it into view and returns where it sits, which is
   * what the input events need, plus a short name for the live view's caption.
   * Field values are never used as the name, so a password cannot end up there.
   */
  private async target(selector: string): Promise<Target> {
    const found = await this.evaluate<(Rect & { name: string }) | null>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        el.scrollIntoView({ block: "center", inline: "center" })
        const r = el.getBoundingClientRect()
        const clean = (value) => (value ? String(value).replace(/\\s+/g, " ").trim() : "")
        const field = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"
        const buttonInput = el.tagName === "INPUT" && /^(submit|button|reset)$/i.test(el.type || "")
        const label = el.labels && el.labels[0] ? el.labels[0].innerText : ""
        const name =
          clean(el.getAttribute("aria-label")) ||
          clean(label) ||
          clean(el.getAttribute("placeholder")) ||
          (field ? "" : clean(el.innerText)) ||
          (buttonInput ? clean(el.value) : "") ||
          clean(el.getAttribute("title")) ||
          clean(el.getAttribute("alt")) ||
          clean(el.getAttribute("name"))
        return { x: r.x, y: r.y, width: r.width, height: r.height, name: name.slice(0, 48) }
      })()`,
    )
    if (!found) throw new ElementNotFoundError(selector)
    const { name, ...rect } = found
    return { rect, name }
  }

  async exists(selector: string) {
    return this.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`)
  }

  /**
   * Brings the pointer to the middle of a target. For an audience the cursor
   * glides there and outlines the element first; the page itself only ever
   * sees one move, so behaviour does not depend on being watched.
   */
  private async point(target: Target) {
    const x = target.rect.x + target.rect.width / 2
    const y = target.rect.y + target.rect.height / 2
    const from = this.pointer
    this.pointer = { x, y }
    if (this.hooks.presenting()) {
      const distance = Math.hypot(x - from.x, y - from.y)
      const duration = Math.round(Math.min(GLIDE_MAX, Math.max(GLIDE_MIN, GLIDE_MIN + distance * GLIDE_PER_PIXEL)))
      const { rect } = target
      await this.cursor("highlight", [rect.x, rect.y, rect.width, rect.height], from)
      await this.cursor("move", [x, y, duration], from)
      await sleep(duration)
    }
    await this.connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" })
    return { x, y }
  }

  private async pressAt(x: number, y: number, button: "left" | "right", clickCount: number) {
    const presenting = this.hooks.presenting()
    if (presenting) await this.cursor("click", [])
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount,
      buttons: button === "right" ? 2 : 1,
    })
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount,
      buttons: 0,
    })
    if (presenting) await sleep(CLICK_SETTLE)
  }

  async click(selector: string, button: "left" | "right" = "left", clickCount = 1) {
    const target = await this.target(selector)
    this.announce(clickCount > 1 ? "double_click" : button === "right" ? "right_click" : "click", target.name)
    const { x, y } = await this.point(target)
    await this.pressAt(x, y, button, clickCount)
  }

  async hover(selector: string) {
    const target = await this.target(selector)
    this.announce("hover", target.name)
    await this.point(target)
  }

  async focus(selector: string) {
    const ok = await this.evaluate<boolean>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        el.scrollIntoView({ block: "center", inline: "center" })
        el.focus()
        return true
      })()`,
    )
    if (!ok) throw new ElementNotFoundError(selector)
  }

  /**
   * Inserts text at the caret. Watched, it arrives a few characters at a time
   * so typing is visible; a long text finishes in one go once the pause budget
   * is spent, so nobody waits on a paragraph being typed out.
   */
  private async insert(text: string) {
    if (!this.hooks.presenting()) {
      await this.connection.send("Input.insertText", { text })
      return
    }
    const chars = Array.from(text)
    const paced = Math.min(chars.length, Math.floor(TYPE_BUDGET / TYPE_DELAY))
    for (const char of chars.slice(0, paced)) {
      await this.connection.send("Input.insertText", { text: char })
      await sleep(TYPE_DELAY)
    }
    const rest = chars.slice(paced).join("")
    if (rest) await this.connection.send("Input.insertText", { text: rest })
  }

  /**
   * Replaces a field's value. The existing text is selected and typed over
   * rather than assigned, because assigning `value` directly does not notify
   * frameworks like React.
   */
  async fill(selector: string, text: string) {
    const target = await this.target(selector)
    this.announce("fill", target.name)
    const { x, y } = await this.point(target)
    await this.pressAt(x, y, "left", 1)
    await this.focus(selector)
    await this.key("Control+a")
    await this.key("Delete")
    if (text) await this.insert(text)
    await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
      })()`,
    )
  }

  /** Types character by character, which is what triggers autocomplete. */
  async type(selector: string | undefined, text: string) {
    if (selector) {
      const target = await this.target(selector)
      this.announce("type", target.name)
      const { x, y } = await this.point(target)
      await this.pressAt(x, y, "left", 1)
      await this.focus(selector)
    } else this.announce("type")

    const presenting = this.hooks.presenting()
    let budget = TYPE_BUDGET
    for (const char of text) {
      await this.connection.send("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char })
      await this.connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: char })
      if (presenting && budget > 0) {
        budget -= TYPE_DELAY
        await sleep(TYPE_DELAY)
      }
    }
  }

  async press(name: string, selector?: string) {
    this.announce("press", name)
    if (selector) await this.focus(selector)
    await this.key(name)
  }

  /** Sends one key or shortcut, without reporting it as an action of its own. */
  private async key(name: string) {
    const key = describeKey(name)
    await this.connection.send("Input.dispatchKeyEvent", {
      type: key.text ? "keyDown" : "rawKeyDown",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      modifiers: key.modifiers,
      ...(key.text ? { text: key.text } : {}),
    })
    await this.connection.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      modifiers: key.modifiers,
    })
  }

  async select(selector: string, value: string) {
    const target = await this.target(selector)
    this.announce("select", target.name)
    await this.point(target)
    if (this.hooks.presenting()) await this.cursor("click", [])
    const ok = await this.evaluate<boolean>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        const wanted = ${JSON.stringify(value)}
        const option = Array.from(el.options || []).find(
          (o) => o.label === wanted || o.text === wanted || o.value === wanted,
        )
        if (!option) return false
        el.value = option.value
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        return true
      })()`,
    )
    if (!ok) throw new Error(`No option matching "${value}" in ${selector}`)
  }

  async setChecked(selector: string, checked: boolean) {
    const current = await this.evaluate<boolean | null>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        return el.checked === true || el.getAttribute("aria-checked") === "true"
      })()`,
    )
    if (current === null) throw new ElementNotFoundError(selector)
    if (current === checked) return
    const target = await this.target(selector)
    this.announce(checked ? "check" : "uncheck", target.name)
    const { x, y } = await this.point(target)
    await this.pressAt(x, y, "left", 1)
  }

  async scroll(selector: string | undefined, x: number, y: number) {
    this.announce("scroll")
    // Watched, the page glides instead of jumping, and the view waits for it.
    const behavior = this.hooks.presenting() ? "smooth" : "auto"
    if (selector) {
      await this.evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)})
          if (el) el.scrollBy({ left: ${x}, top: ${y}, behavior: "${behavior}" })
        })()`,
      )
    } else await this.evaluate(`window.scrollBy({ left: ${x}, top: ${y}, behavior: "${behavior}" })`)
    if (behavior === "smooth") await sleep(SCROLL_SETTLE)
  }

  /** Polls until an element is visible, or until `text` appears on the page. */
  async waitFor(input: { selector?: string; text?: string }, timeout: number) {
    this.announce("wait", input.text)
    const deadline = Date.now() + timeout
    const condition = input.selector
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(input.selector)})
          if (!el) return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        })()`
      : `document.body && document.body.innerText.includes(${JSON.stringify(input.text ?? "")})`

    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(condition).catch(() => false)) return
      await sleep(150)
    }
    throw new Error(
      input.selector
        ? `${input.selector} did not become visible within ${timeout}ms`
        : `"${input.text}" did not appear within ${timeout}ms`,
    )
  }

  /** A PNG for the model. The cursor overlay is hidden so the model sees only the page. */
  async screenshot(options: { selector?: string; fullPage?: boolean } = {}) {
    let clip: (Rect & { scale: number }) | undefined

    if (options.selector) {
      const { rect } = await this.target(options.selector)
      const origin = await this.evaluate<{ x: number; y: number }>(`({ x: window.scrollX, y: window.scrollY })`)
      clip = { x: rect.x + origin.x, y: rect.y + origin.y, width: rect.width, height: rect.height, scale: 1 }
    } else if (options.fullPage) {
      const metrics = await this.connection.send<LayoutMetrics>("Page.getLayoutMetrics")
      const size = metrics.cssContentSize ?? metrics.contentSize
      clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
    }

    await this.cursor("hide", [1])
    try {
      const result = await this.connection.send<ScreenshotResult>("Page.captureScreenshot", {
        format: "png",
        ...(clip ? { clip, captureBeyondViewport: true } : {}),
      })
      return Buffer.from(result.data, "base64")
    } finally {
      await this.cursor("hide", [0])
    }
  }

  /** A JPEG of the viewport as a person would see it, cursor included. */
  async frame(): Promise<Frame> {
    const [shot, size] = await Promise.all([
      this.connection.send<ScreenshotResult>("Page.captureScreenshot", { format: "jpeg", quality: 72 }),
      this.evaluate<{ width: number; height: number }>(
        "({ width: window.innerWidth, height: window.innerHeight })",
      ).catch(() => ({ width: 0, height: 0 })),
    ])
    return { data: shot.data, width: size.width, height: size.height }
  }

  /**
   * Streams the tab as it repaints. Chromium only sends a frame when something
   * changed, and waits for each acknowledgement before sending the next, so an
   * idle page costs nothing.
   */
  async startScreencast(onFrame: (frame: Frame) => void) {
    this.stopCast?.()
    this.stopCast = this.connection.on("Page.screencastFrame", (params) => {
      void this.connection.send("Page.screencastFrameAck", { sessionId: params["sessionId"] }).catch(() => {})
      const metadata = asRecord(params["metadata"])
      onFrame({
        data: asText(params["data"]),
        width: number(metadata["deviceWidth"]),
        height: number(metadata["deviceHeight"]),
      })
    })
    await this.connection.send("Page.startScreencast", {
      format: "jpeg",
      quality: 72,
      maxWidth: 1600,
      maxHeight: 1200,
      everyNthFrame: 1,
    })
  }

  async stopScreencast() {
    this.stopCast?.()
    this.stopCast = undefined
    await this.connection.send("Page.stopScreencast").catch(() => {})
  }

  /** Forwards what the person watching does in the live view. */
  async input(event: UserInput) {
    if (event.type === "mouse") {
      this.pointer = { x: event.x, y: event.y }
      const moving = event.action === "move"
      await this.connection.send("Input.dispatchMouseEvent", {
        type: MOUSE_EVENT[event.action],
        x: event.x,
        y: event.y,
        button: event.button ?? (moving ? "none" : "left"),
        buttons: event.buttons ?? 0,
        clickCount: event.clickCount ?? (moving ? 0 : 1),
        modifiers: event.modifiers ?? 0,
      })
      return
    }
    if (event.type === "wheel") {
      await this.connection.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: event.modifiers ?? 0,
      })
      return
    }
    if (event.type === "key") {
      const down = event.action === "down"
      await this.connection.send("Input.dispatchKeyEvent", {
        type: down ? (event.text ? "keyDown" : "rawKeyDown") : "keyUp",
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        nativeVirtualKeyCode: event.keyCode,
        modifiers: event.modifiers ?? 0,
        ...(down && event.text ? { text: event.text, unmodifiedText: event.text } : {}),
      })
      return
    }
    await this.connection.send("Input.insertText", { text: event.text })
  }

  /**
   * Lays the page out at a given viewport size, so it fills the live view the
   * way a real browser window fills its frame. The agent works at the same
   * size, so what it sees and what is shown are one and the same.
   */
  async resize(width: number, height: number) {
    await this.connection.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      // Zero keeps the machine's own pixel density rather than faking one.
      deviceScaleFactor: 0,
      mobile: false,
    })
  }

  async bringToFront() {
    await this.connection.send("Page.bringToFront").catch(() => {})
  }

  close() {
    this.stopCast?.()
    this.stopCast = undefined
    this.connection.close()
  }
}

export * as BrowserTab from "./tab"
