import fs from "fs/promises"
import path from "path"
import { CDPConnection, ReplacedError, type CDPTransport, type SlowCall } from "./cdp"
import { BrowserCursor } from "./cursor"
import { BrowserSnapshot, type RefIdentity, type SnapshotOptions, type SnapshotResult } from "./snapshot"
import { BrowserTrace } from "./trace"
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

/** The response that served the tab's top-level page. */
export interface DocumentResponse {
  url: string
  status: number
  /** Header names lower-cased, since HTTP/2 and HTTP/1 disagree on case. */
  headers: Record<string, string>
  /** What the browser took the response to be, such as text/html or application/pdf. */
  mimeType: string
}

/** A dialog the page opened (alert, confirm, prompt, or "leave this page?"), and how it was answered. */
export interface Dialog {
  type: string
  message: string
  accepted: boolean
}

export interface Download {
  url: string
  /** The file name the browser would save it under. */
  name: string
  at: number
}

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
  | "drag"
  | "upload"
  | "wait"
  | "read"
  | "screenshot"
  | "inspect"
  | "handoff"

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
  /** Whether the live view in the app is open, as opposed to only the browser's own window being on screen. */
  watched?(): boolean
  activity(activity: Activity): void
  changed(): void
}

/** Navigation counters at one moment, to tell what an action set off since. */
export interface Mark {
  started: number
  stopped: number
  /** DOMContentLoaded, which is when a document is readable. */
  loaded: number
  /** The load event, which also waits for images and stylesheets. */
  complete: number
  request: number
}

const IDLE: TabHooks = { presenting: () => false, activity: () => {}, changed: () => {} }

const BUFFER_LIMIT = 300

/**
 * Pace while someone watches. Without an audience the agent acts at full speed;
 * with one, the cursor needs a moment to travel (the glide itself is timed by
 * the overlay, see cursor.ts) and a click a beat to land, or the view is a
 * series of teleports. Kept short: the point is to follow the agent, not to
 * slow it down.
 */
const CLICK_SETTLE = 40
/**
 * Watched typing is spread over at most `TYPE_BUDGET` ms, a few characters per
 * `TYPE_TICK` (about a frame), so it is visible without a long text taking long.
 */
const TYPE_TICK = 16
const TYPE_BUDGET = 300
const SCROLL_SETTLE = 350

/**
 * Settling after an action. A click that does not navigate never fires a load
 * event, so instead of waiting for one the page is watched: it has settled once
 * its DOM has been still for `QUIET` ms, or after `QUIET_MAX` ms on a page that
 * never stops animating.
 */
const QUIET = 100
const QUIET_MAX = 800
/** Refs of earlier pages still answered for; a few pages' worth of menus. */
const ALIAS_MAX = 3000
/** How often a page whose timers are held back is asked whether it changed. */
const QUIET_POLL = 40
/** A request the action set off, such as a form post or an answer being checked, gets this long to come back. */
const REQUEST_MAX = 2500
/** A navigation the action started gets this long to reach DOMContentLoaded. */
const NAVIGATION_MAX = 15_000
/**
 * How long a navigation that was asked for has to actually start. Past this,
 * nothing left the page — a link to the same document, a fragment, a page that
 * was already where it was being sent — and there is nothing to wait for.
 */
const NAVIGATION_START = 1500
/**
 * How long a script sent to a page that has since been replaced by another
 * document may still answer. Its context is gone, so normally the browser says
 * so at once; through the extension the reply can instead never come, and the
 * command sat out the whole 30 s call timeout, twice per click that submitted a
 * form on a Moodle quiz.
 */
const ORPHAN_GRACE = 2000
/** Request types that end in a re-render; images, fonts and beacons hold nothing up. */
const SETTLE_TYPES = new Set(["XHR", "Fetch", "Document"])
/** How recently the agent must have acted for a new document to show its cursor again. */
const CURSOR_CARRY = 3000
/**
 * How far the element may have moved between aiming and pressing before the
 * drawn cursor is sent after it. Below this it is not worth an animation, and
 * the press is at the new point either way.
 */
const CURSOR_DRIFT = 2
/** How long the cursor takes to catch up with an element that moved. */
const CURSOR_CATCHUP = 90

/**
 * The fastest the live view is fed, in milliseconds between pictures.
 *
 * Chromium holds the next screencast frame until the last one is acknowledged,
 * so when the acknowledgement goes out is what sets the pace. A page that
 * animates would otherwise make every picture it can, and nobody has time to
 * look at them: each one costs a JPEG, a trip through the extension and the
 * socket, and a decode in the pane. Worse, on the extension bridge frames and
 * command replies share one socket, so a click waits behind whatever is queued
 * in front of it. Measured on a page animating flat out, this takes the stream
 * from 49 pictures and 961 KB a second to 21 and 419 KB: still live to watch,
 * with the socket free for what the hand is doing. It was then slowed to about
 * 10 a second: the stream was still most of what the app's network process
 * and event stream spent CPU on while the agent browsed.
 */
const CAST_INTERVAL = 100
/** How much longer the next picture may wait for the agent's commands to be answered first. */
const CAST_YIELD = 300

/**
 * Finds an element in the page or in any frame of the same site inside it,
 * which is where embedded activities such as H5P quizzes live, and where the
 * snapshot hands out refs too. Ref lookups inspect every match so a cloned ref
 * cannot silently select the wrong copy.
 */
const FIND = String.raw`(function (selector, identity) {
  function collect(doc, scopes) {
    var roots = [doc]
    for (var index = 0; index < roots.length; index++) {
      var root = roots[index]
      scopes.push(root)
      var elements = root.querySelectorAll("*")
      for (var i = 0; i < elements.length; i++) {
        // Closed roots expose no shadowRoot to page JavaScript and therefore
        // cannot be searched without bypassing the page's own boundary.
        if (elements[i].shadowRoot) roots.push(elements[i].shadowRoot)
      }
      var frames = root.querySelectorAll("iframe, frame")
      for (var f = 0; f < frames.length; f++) {
        var inner = null
        try {
          inner = frames[f].contentDocument
        } catch (error) {}
        if (inner) collect(inner, scopes)
      }
    }
  }
  function matches(selector, scopes) {
    var out = []
    for (var r = 0; r < scopes.length; r++) {
      var found = scopes[r].querySelectorAll(selector)
      for (var i = 0; i < found.length; i++) out.push(found[i])
    }
    return out
  }
  function positionOf(el) {
    var parts = []
    var node = el
    while (node) {
      var parent = node.parentElement
      var index = parent ? Array.prototype.indexOf.call(parent.children, node) : 0
      parts.unshift(node.tagName.toLowerCase() + ":" + index)
      if (parent) {
        node = parent
        continue
      }
      var root = node.getRootNode ? node.getRootNode() : null
      if (root && root.host) {
        parts.unshift("#shadow")
        node = root.host
        continue
      }
      var view = node.ownerDocument && node.ownerDocument.defaultView
      if (view && view !== window && view.frameElement) {
        parts.unshift("#frame")
        node = view.frameElement
        continue
      }
      break
    }
    return parts.join("/")
  }
  var isRef = /^\[data-oc-ref=/.test(selector)
  if (!isRef) {
    var top = document.querySelector(selector)
    if (top) return top
  }
  var scopes = []
  collect(document, scopes)
  var direct = matches(selector, scopes)
  if (direct.length > 1 && isRef) {
    throw new Error("__OC_REF_ERROR__The ref matches more than one element, so it is unsafe to act on it. Take a fresh browser_snapshot and use a new ref.")
  }
  if (direct.length) return direct[0]
  if (!identity || identity.document !== window.__ocDocumentIdentity) return null

  var HEADINGS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 }
  var LANDMARKS = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog" }
  function clean(value) {
    return value ? String(value).replace(/\s+/g, " ").trim() : ""
  }
  function roleOf(el) {
    var explicit = el.getAttribute("role")
    if (explicit) return explicit.trim().split(/\s+/)[0]
    var tag = el.tagName
    if (HEADINGS[tag]) return "heading"
    if (LANDMARKS[tag]) return LANDMARKS[tag]
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic"
    if (tag === "BUTTON" || tag === "SUMMARY") return "button"
    if (tag === "SELECT") return el.hasAttribute("multiple") ? "listbox" : "combobox"
    if (tag === "TEXTAREA") return "textbox"
    if (tag === "IMG") return "img"
    if (tag === "TABLE") return "table"
    if (tag === "UL" || tag === "OL") return "list"
    if (tag === "LI") return "listitem"
    if (tag === "OPTION") return "option"
    if (tag === "IFRAME") return "iframe"
    if (tag === "INPUT") {
      var type = (el.getAttribute("type") || "text").toLowerCase()
      if (type === "hidden") return "hidden"
      if (type === "checkbox") return "checkbox"
      if (type === "radio") return "radio"
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button"
      if (type === "search") return "searchbox"
      if (type === "range") return "slider"
      if (type === "number") return "spinbutton"
      return "textbox"
    }
    if (el.isContentEditable) return "textbox"
    if (el.hasAttribute("onclick")) return "button"
    return "generic"
  }
  function labelFor(el) {
    if (el.id) {
      var escaped = window.CSS && window.CSS.escape ? window.CSS.escape(el.id) : el.id
      var root = el.getRootNode ? el.getRootNode() : el.ownerDocument
      var label = root.querySelector("label[for=" + JSON.stringify(escaped) + "]")
      if (label) return label.innerText || label.textContent
    }
    var parent = el.closest ? el.closest("label") : null
    return parent ? parent.innerText || parent.textContent : ""
  }
  function nameOf(el, role) {
    var aria = el.getAttribute("aria-label")
    if (aria) return clean(aria)
    var labelledby = el.getAttribute("aria-labelledby")
    if (labelledby) {
      var root = el.getRootNode ? el.getRootNode() : el.ownerDocument
      var parts = labelledby.split(/\s+/).map(function (id) {
        var target = root.getElementById ? root.getElementById(id) : root.querySelector("#" + CSS.escape(id))
        return target ? target.innerText || target.textContent || "" : ""
      }).filter(Boolean)
      if (parts.length) return clean(parts.join(" "))
    }
    if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton") {
      return clean(labelFor(el) || el.getAttribute("placeholder") || el.getAttribute("name"))
    }
    if (el.tagName === "IMG") return clean(el.getAttribute("alt"))
    if (el.tagName === "INPUT") {
      // As the snapshot names it: a radio or checkbox by its label, not its form value.
      var type = (el.getAttribute("type") || "").toLowerCase()
      if (type === "radio" || type === "checkbox") return clean(labelFor(el) || el.getAttribute("value") || el.getAttribute("name"))
      return clean(el.getAttribute("value") || labelFor(el) || el.getAttribute("name"))
    }
    return clean(el.innerText || el.textContent || el.getAttribute("title"))
  }
  var candidates = []
  for (var r = 0; r < scopes.length; r++) {
    var elements = scopes[r].querySelectorAll(identity.tag)
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i]
      var role = roleOf(el)
      if (role !== identity.role) continue
      if (nameOf(el, role) !== identity.name) continue
      if (clean(el.getAttribute("href")) !== identity.href) continue
      if (clean(el.getAttribute("placeholder")) !== identity.placeholder) continue
      // An anonymous control has too little semantic identity to follow if
      // it also moved; its composed-tree position is the final safety check.
      if (!identity.name && !identity.href && !identity.placeholder && positionOf(el) !== identity.position) continue
      candidates.push(el)
    }
  }
  if (candidates.length > 1) {
    throw new Error("__OC_REF_ERROR__The old ref is gone and its identity matches more than one element, so it is unsafe to guess. Take a fresh browser_snapshot and use a new ref.")
  }
  return candidates[0] || null
})`

/** An element's box in the top page's viewport, adding up the frames it sits in. */
const RECT = String.raw`(function (el) {
  var r = el.getBoundingClientRect()
  var x = r.x
  var y = r.y
  var view = el.ownerDocument.defaultView
  while (view && view !== window && view.frameElement) {
    var frame = view.frameElement
    var box = frame.getBoundingClientRect()
    var style = view.parent.getComputedStyle(frame)
    x += box.x + frame.clientLeft + (parseFloat(style.paddingLeft) || 0)
    y += box.y + frame.clientTop + (parseFloat(style.paddingTop) || 0)
    view = view.parent
  }
  return { x: x, y: y, width: r.width, height: r.height }
})`

/** The visible text of a document and of the frames of the same site inside it. */
const TEXT_IN_FRAMES = String.raw`(function text(doc) {
  var body = doc.body
  var out = body ? body.innerText || body.textContent || "" : ""
  var frames = doc.querySelectorAll("iframe, frame")
  for (var i = 0; i < frames.length; i++) {
    var inner = null
    try {
      inner = frames[i].contentDocument
    } catch (error) {}
    if (inner) out += "\n" + text(inner)
  }
  return out
})`

/**
 * The text a screenshot shows, in reading order: every text on screen, or on
 * the whole page. Many models cannot see images, and a screenshot is often
 * asked for precisely to read what is on the page.
 */
const VISIBLE_TEXT = String.raw`(function (whole, max) {
  var out = []
  var size = 0
  function read(doc, dx, dy) {
    var view = doc.defaultView
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    var node
    while ((node = walker.nextNode()) && size < max) {
      var text = node.nodeValue.replace(/\s+/g, " ").trim()
      if (!text) continue
      var el = node.parentElement
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue
      var style = view.getComputedStyle(el)
      if (style.visibility === "hidden" || style.opacity === "0") continue
      var range = doc.createRange()
      range.selectNodeContents(node)
      var r = range.getBoundingClientRect()
      if (!r.width || !r.height) continue
      var top = r.top + dy
      var left = r.left + dx
      if (!whole && (top + r.height < 0 || top > innerHeight || left + r.width < 0 || left > innerWidth)) continue
      if (out.length && out[out.length - 1] === text) continue
      out.push(text)
      size += text.length + 1
    }
    var frames = doc.querySelectorAll("iframe, frame")
    for (var i = 0; i < frames.length; i++) {
      var inner = null
      try {
        inner = frames[i].contentDocument
      } catch (error) {}
      if (!inner || !inner.body) continue
      var box = frames[i].getBoundingClientRect()
      read(inner, dx + box.left, dy + box.top)
    }
  }
  if (document.body) read(document, 0, 0)
  var text = out.join("\n")
  return text.length > max ? text.slice(0, max) + "\n…" : text
})`

/**
 * The expression that finds `selector`, in the page or its frames. Exported so
 * whatever else needs to look at the very element an action worked on reads it
 * the same way the action did, frames included.
 */
export function find(selector: string, identity?: RefIdentity) {
  return `(${FIND})(${JSON.stringify(selector)}, ${JSON.stringify(identity)})`
}

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

/** Keys that can be held while clicking or dragging. */
export const MODIFIER_KEYS = ["Alt", "Control", "Meta", "Shift"] as const
export type Modifier = (typeof MODIFIER_KEYS)[number]

/** The bitmask the protocol wants for a set of held keys. */
function mask(modifiers: readonly Modifier[]) {
  let bits = 0
  for (const name of modifiers) bits |= MODIFIERS[name.toLowerCase()] ?? 0
  return bits
}

/** How many moves a drag is made of; enough for a page to follow the pointer. */
const DRAG_STEPS = 8

/** Larger files are not handed to a page this way; the direct way has no such limit. */
const MAX_UPLOAD = 25 * 1024 * 1024

/** The files to hand to a page from inside it: name, type and contents. */
async function readUploads(files: string[]) {
  return Promise.all(
    files.map(async (file) => {
      const bytes = await fs.readFile(file)
      if (bytes.byteLength > MAX_UPLOAD) throw new Error(`${file} is larger than ${MAX_UPLOAD / 1024 / 1024} MB.`)
      return { name: path.basename(file), type: MIME[path.extname(file).toLowerCase()] ?? "", data: bytes.toString("base64") }
    }),
  )
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

/** Runs in the page: puts the files into the input and tells the page, as a person choosing them would. */
const GIVE_FILES = `(input, files) => {
  if (!input) throw new Error("no such element")
  const transfer = new DataTransfer()
  for (const file of files) {
    const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0))
    transfer.items.add(new File([bytes], file.name, { type: file.type }))
  }
  input.files = transfer.files
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
  return input.files.length
}`

/** Draws a numbered box over each visible element with a ref; see `Tab.markedScreenshot`. */
const MARKS_ON = `(() => {
  document.getElementById("__oc_marks")?.remove()
  const layer = document.createElement("div")
  layer.id = "__oc_marks"
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647"
  const marked = []
  // Frames of the same site are part of the page, as in the outline; their
  // boxes are offset by where the frame sits.
  const mark = (doc, dx, dy) => {
    const view = doc.defaultView
    for (const el of doc.querySelectorAll("[data-oc-ref]")) {
      const box = el.getBoundingClientRect()
      if (box.width < 2 || box.height < 2) continue
      if (box.bottom < 0 || box.right < 0 || box.top > view.innerHeight || box.left > view.innerWidth) continue
      const left = box.left + dx
      const top = box.top + dy
      if (top + box.height < 0 || left + box.width < 0 || top > innerHeight || left > innerWidth) continue
      const x = Math.min(view.innerWidth - 1, Math.max(0, box.left + box.width / 2))
      const y = Math.min(view.innerHeight - 1, Math.max(0, box.top + box.height / 2))
      const onTop = doc.elementFromPoint(x, y)
      if (onTop && onTop !== el && !el.contains(onTop) && !onTop.contains(el)) continue
      const ref = el.getAttribute("data-oc-ref")
      const number = ref.replace("ref_", "")
      const hue = (Number(number) * 137) % 360
      const frame = document.createElement("div")
      frame.style.cssText = "position:fixed;box-sizing:border-box;border-radius:3px;left:" + left + "px;top:" + top + "px;width:" + box.width + "px;height:" + box.height + "px;border:2px solid hsl(" + hue + " 90% 42%)"
      const tag = document.createElement("div")
      tag.textContent = number
      tag.style.cssText = "position:absolute;left:-2px;padding:0 3px;border-radius:3px;color:#fff;font:bold 11px/14px sans-serif;background:hsl(" + hue + " 90% 34%);top:" + (top < 16 ? 0 : -16) + "px"
      frame.append(tag)
      layer.append(frame)
      marked.push(ref)
    }
    for (const inner of doc.querySelectorAll("iframe, frame")) {
      let child = null
      try {
        child = inner.contentDocument
      } catch (error) {}
      if (!child || !child.documentElement) continue
      const box = inner.getBoundingClientRect()
      mark(child, dx + box.left + inner.clientLeft, dy + box.top + inner.clientTop)
    }
  }
  mark(document, 0, 0)
  document.documentElement.append(layer)
  return marked
})()`

const MARKS_OFF = `document.getElementById("__oc_marks")?.remove()`

function push<T>(buffer: T[], entry: T) {
  buffer.push(entry)
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Splits typed text into as many chunks as fit in the typing budget, a tick apart. */
function chunks<T>(items: T[]) {
  const size = Math.max(1, Math.ceil(items.length / Math.floor(TYPE_BUDGET / TYPE_TICK)))
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Turns what the model wrote into the value a structured input expects. Date
 * fields want yyyy-mm-dd; a Brazilian model often writes dd/mm/yyyy, so that
 * one common case is converted. Everything else is passed through untouched.
 */
function normalizeFieldValue(type: string, text: string) {
  const value = text.trim()
  if (
    (type === "date" || type === "datetime-local" || type === "month" || type === "week") &&
    /^\d{1,2}[/-]\d{1,2}[/-]\d{4}/.test(value)
  ) {
    const parts = value.split(/[/-]/)
    const day = parts[0].padStart(2, "0")
    const month = parts[1].padStart(2, "0")
    const year = parts[2].slice(0, 4)
    return `${year}-${month}-${day}`
  }
  return value
}

/** Whether any of the scroll positions read before and after an action differ. */
function moved(before: number[], after: number[]) {
  if (before.length !== after.length) return true
  return before.some((value, index) => value !== after[index])
}

/**
 * Which key a character comes from on a US keyboard.
 *
 * A page that masks a phone number, completes an address or drives an editor
 * reads `code` and `keyCode` off the event, and both are zero if a character is
 * sent as text alone. Only the punctuation that turns up in what an agent
 * types - addresses, dates, prices, paths - is listed; anything else, an
 * accented letter or a character from another script, still carries its text,
 * which is what puts it in the field.
 */
const PUNCTUATION: Record<string, { code: string; keyCode: number; shift?: boolean }> = {
  " ": { code: "Space", keyCode: 32 },
  "!": { code: "Digit1", keyCode: 49, shift: true },
  "@": { code: "Digit2", keyCode: 50, shift: true },
  "#": { code: "Digit3", keyCode: 51, shift: true },
  $: { code: "Digit4", keyCode: 52, shift: true },
  "%": { code: "Digit5", keyCode: 53, shift: true },
  "&": { code: "Digit7", keyCode: 55, shift: true },
  "*": { code: "Digit8", keyCode: 56, shift: true },
  "(": { code: "Digit9", keyCode: 57, shift: true },
  ")": { code: "Digit0", keyCode: 48, shift: true },
  "-": { code: "Minus", keyCode: 189 },
  _: { code: "Minus", keyCode: 189, shift: true },
  "=": { code: "Equal", keyCode: 187 },
  "+": { code: "Equal", keyCode: 187, shift: true },
  "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  ":": { code: "Semicolon", keyCode: 186, shift: true },
  "'": { code: "Quote", keyCode: 222 },
  '"': { code: "Quote", keyCode: 222, shift: true },
  ",": { code: "Comma", keyCode: 188 },
  "<": { code: "Comma", keyCode: 188, shift: true },
  ".": { code: "Period", keyCode: 190 },
  ">": { code: "Period", keyCode: 190, shift: true },
  "/": { code: "Slash", keyCode: 191 },
  "?": { code: "Slash", keyCode: 191, shift: true },
  "`": { code: "Backquote", keyCode: 192 },
  "~": { code: "Backquote", keyCode: 192, shift: true },
}

/** One character as a key press: what to send so the page sees a person typing it. */
function describeChar(char: string) {
  if (/^[a-z]$/.test(char))
    return { key: char, code: `Key${char.toUpperCase()}`, keyCode: char.toUpperCase().charCodeAt(0), shift: false }
  if (/^[A-Z]$/.test(char)) return { key: char, code: `Key${char}`, keyCode: char.charCodeAt(0), shift: true }
  if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), shift: false }
  const known = PUNCTUATION[char]
  if (known) return { key: char, code: known.code, keyCode: known.keyCode, shift: known.shift === true }
  // Anything else - an accented letter, another script, an emoji - has no key
  // of its own on this layout. Its text is what matters and is still sent.
  return { key: char, code: "", keyCode: 0, shift: false }
}

function describeKey(name: string) {
  const parts = name.split("+")
  const last = parts.pop() ?? "Enter"
  let modifiers = 0
  for (const part of parts) modifiers |= MODIFIERS[part.toLowerCase()] ?? 0
  const known = KEYS[last.toLowerCase()]
  if (known) return { ...known, modifiers }
  if (last.length === 1) {
    const char = describeChar(last)
    return {
      key: last,
      code: char.code,
      keyCode: char.keyCode,
      // A modified key is a shortcut, not typed input, so it carries no text,
      // and "Control+A" means ctrl and A rather than ctrl, shift and A.
      text: modifiers === 0 ? last : undefined,
      modifiers: modifiers === 0 && char.shift ? MODIFIERS["shift"]! : modifiers,
    }
  }
  return { key: last, code: last, keyCode: 0, text: undefined, modifiers }
}

/**
 * Failures the page never saw.
 *
 * An element that could not be found, or that nothing could reach, fails before
 * a single input event is dispatched, so the action provably did not happen.
 * That is what makes it safe to look again and try once more, whatever the
 * action was: retrying a "Delete" that was never sent deletes nothing. A
 * failure after the press is not one of these and is never retried.
 */
export interface PreDispatchError extends Error {
  readonly retryable: true
}

export function isPreDispatch(error: unknown): error is PreDispatchError {
  return error instanceof Error && (error as { retryable?: unknown }).retryable === true
}

export class ElementNotFoundError extends Error {
  readonly retryable = true as const
  constructor(target: string, detail?: string) {
    super(
      [
        detail ?? `No element matches ${target} on the current page.`,
        "The element is gone or the page changed, so take a fresh browser_snapshot and use a ref from it.",
      ].join(" "),
    )
    this.name = "ElementNotFoundError"
  }
}

/**
 * The tab can no longer be driven. Through the extension this is what the
 * browser does when a tab moves to a page extensions may not touch, such as
 * its own PDF viewer or a settings page; the tab is still there for the
 * person, just out of the agent's reach.
 */
export class TabGoneError extends Error {
  constructor() {
    super(
      "This tab can no longer be controlled: it was closed, or it moved to a page the browser does not let extensions drive (its PDF viewer or a browser page). Call browser_navigate to continue; it takes another tab. To read a PDF, browser_navigate to its URL.",
    )
    this.name = "TabGoneError"
  }
}

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EvaluationError"
  }
}

/** A script whose page was replaced by another document before it answered. */
export class PageReplacedError extends Error {
  constructor() {
    super("The page changed to another document while this was running.")
    this.name = "PageReplacedError"
  }
}

/** What the page reports about an element, as {@link MEASURE} returns it. */
interface Measured extends Rect {
  name: string
  checked: boolean
  draggable: boolean
  ox: number
  oy: number
  cover: string
  view: { width: number; height: number; scrollX: number; scrollY: number; dpr: number }
}

interface Target {
  rect: Rect
  /** Where a click reaches the element itself, in the top page's viewport: its middle unless something covers that. */
  point: { x: number; y: number }
  name: string
  /** How long the cursor takes to glide there; zero when nobody is watching. */
  duration: number
  checked: boolean
  draggable: boolean
  /** The page around the element when it was measured, for the trace. */
  view: Measured["view"]
}

/** Points of an element tried in turn for one that a click would actually reach. */
const SPOTS = [
  [0.5, 0.5],
  [0.25, 0.5],
  [0.75, 0.5],
  [0.5, 0.25],
  [0.5, 0.75],
  [0.15, 0.15],
  [0.85, 0.85],
]

/**
 * Measures an element inside the page: where it sits in the top page's
 * viewport, where a click would really reach it, what it is called, and what
 * the page looks like around it.
 *
 * It is its own function because it is run twice per action: once to aim, and
 * once again just before the press, so the coordinates that reach the page
 * describe where the element is *now* rather than where it was when the agent
 * started moving towards it. Both measurements must be the same measurement,
 * so there is one source for it.
 */
const MEASURE = String.raw`(function (el, spots) {
  var rect = ${RECT}
  // Coordinates in the top page, since that is where input events land, even
  // for an element inside a frame.
  var r = rect(el)
  var own = el.getBoundingClientRect()
  var view = el.ownerDocument.defaultView || window
  // Only scroll when needed: jumping a visible element to the middle of the
  // screen on every action is jarring to watch.
  var inside = function (box, width, height) {
    return box.top >= 0 && box.left >= 0 && box.bottom <= height && box.right <= width
  }
  var shown =
    inside(own, view.innerWidth, view.innerHeight) &&
    inside({ top: r.y, left: r.x, bottom: r.y + r.height, right: r.x + r.width }, innerWidth, innerHeight)
  if (!shown) {
    // From inside a frame this scrolls the pages around it too.
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
    r = rect(el)
  }
  // What a click at a point of the element would really hit: a sticky banner,
  // a popup or an ad can sit on top of it, and the click would land there. The
  // element's own parts and its labels are fine.
  var doc = el.ownerDocument
  var deepest = function (x, y) {
    var hit = doc.elementFromPoint(x, y)
    while (hit && hit.shadowRoot) {
      var inner = hit.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === hit) break
      hit = inner
    }
    return hit
  }
  var reaches = function (x, y) {
    // Document hit-testing stops at a shadow host. Descending open roots keeps
    // an internal target from looking falsely covered by its own host.
    var hit = deepest(x, y)
    if (!hit) return false
    if (hit === el || el.contains(hit) || hit.contains(el)) return true
    return !!(
      el.labels &&
      Array.prototype.some.call(el.labels, function (label) {
        return label === hit || label.contains(hit)
      })
    )
  }
  var spot = function () {
    var b = el.getBoundingClientRect()
    for (var i = 0; i < spots.length; i++) {
      var x = b.left + b.width * spots[i][0]
      var y = b.top + b.height * spots[i][1]
      if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) continue
      if (reaches(x, y)) return [x - b.left, y - b.top]
    }
    return null
  }
  var offset = spot()
  if (!offset && shown) {
    // Covered where it sits, as by a banner along an edge: bring it to the middle.
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
    r = rect(el)
    offset = spot()
  }
  var cover = ""
  if (!offset) {
    var b = el.getBoundingClientRect()
    var hit = deepest(b.left + b.width / 2, b.top + b.height / 2)
    if (hit) {
      var text = String(hit.innerText || hit.getAttribute("aria-label") || hit.title || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60)
      var ad =
        /google_ads|aswift|doubleclick|safeframe/i.test(hit.id + " " + (hit.src || "")) ||
        /publicidade|advertisement|an[uú]ncio/i.test(hit.title || "")
      cover = ad
        ? "an ad"
        : "<" + hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") + ">" + (text ? ' "' + text + '"' : "")
    }
    offset = [b.width / 2, b.height / 2]
  }
  var clean = function (value) {
    return value ? String(value).replace(/\s+/g, " ").trim() : ""
  }
  var field = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"
  var buttonInput = el.tagName === "INPUT" && /^(submit|button|reset)$/i.test(el.type || "")
  var label = el.labels && el.labels[0] ? el.labels[0].innerText : ""
  var name =
    clean(el.getAttribute("aria-label")) ||
    clean(label) ||
    clean(el.getAttribute("placeholder")) ||
    (field ? "" : clean(el.innerText)) ||
    (buttonInput ? clean(el.value) : "") ||
    clean(el.getAttribute("title")) ||
    clean(el.getAttribute("alt")) ||
    clean(el.getAttribute("name"))
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    name: name.slice(0, 48),
    checked: el.checked === true || el.getAttribute("aria-checked") === "true",
    draggable: el.draggable === true,
    ox: offset[0],
    oy: offset[1],
    cover: cover,
    view: {
      width: innerWidth,
      height: innerHeight,
      scrollX: scrollX,
      scrollY: scrollY,
      dpr: devicePixelRatio || 1,
    },
  }
})`

export class CoveredError extends Error {
  readonly retryable = true as const
  constructor(target: string, cover: string) {
    super(
      `${target} is covered by ${cover}, so a click would land on that instead. Close or get past what covers it (a popup or an ad, often with a close or "X" button; a cookie banner with its option that declines non-essential cookies, such as "Reject all" or "Recusar"), or scroll, then try again.`,
    )
    this.name = "CoveredError"
  }
}

/**
 * One browser tab, driven over CDP.
 *
 * Interactions go through real input events at the element's own coordinates
 * rather than synthetic DOM clicks, so sites that listen for pointer events, or
 * frameworks that ignore programmatic value assignment, behave as they would
 * for a person. What actually reaches the page is the same whether or not
 * anyone is watching; watching only adds the visible cursor and short pauses.
 */
export class Tab {
  readonly console: ConsoleEntry[] = []
  readonly network: NetworkEntry[] = []
  /** Dialogs answered since the model was last told about them. */
  private dialogs: Dialog[] = []
  /** Files the page started downloading, newest last, so an action that downloaded one can read it. */
  private downloads: Download[] = []
  /** The last top-level page response, which bot walls give away through. */
  document?: DocumentResponse
  /** The last outline the model was given, so an action can report only what it changed. */
  baseline?: SnapshotResult
  /** The last outline the model was given whole, which later pages leave repeated menus out against. */
  anchor?: SnapshotResult
  /** How long each part of the last action took, in milliseconds. */
  timing?: Record<string, number>
  private inflight = new Set<string>()
  private requestIds = new Map<string, NetworkEntry>()
  /** Requests that end in a re-render, with the sequence number each started at. */
  private pending = new Map<string, number>()
  /**
   * Where the agent's pointer last was, in viewport CSS pixels. It is put in
   * the middle of the page as the tab is prepared, so the cursor's first glide
   * starts from somewhere on screen.
   */
  private pointer = { x: 0, y: 0 }
  private stopCast?: () => void
  /** What the live view last asked the browser for, to ask again after the tab is attached anew. */
  private castRequest?: Record<string, unknown>
  /** Hosts blocked in this tab, for the same reason. */
  private blockedHosts?: readonly string[]
  /** Live-view input in flight, so events reach the page in the order the hand made them. */
  private inputs: Promise<void> = Promise.resolve()
  /** The action running now, so two tool calls that arrive together do not interleave their input. */
  private actionChain: Promise<unknown> = Promise.resolve()
  /** The main frame's id. It is the target id over a debugging port, but not through the extension. */
  private mainFrame: string
  /** Counted from events as they arrive, so a wait that starts late cannot miss one. */
  private counts: Mark = { started: 0, stopped: 0, loaded: 0, complete: 0, request: 0 }
  /** The highest ref handed out in this tab, so a new document continues the numbering. */
  private refMax = 0
  /** Last known identity for each ref, retained when a framework replaces its node. */
  private refIdentities = new Map<string, RefIdentity>()
  private refDocument?: string
  /**
   * Refs from an earlier page that point at the same element on this one: a
   * menu that was left out of the outline because it had not changed keeps the
   * refs the model saw it with.
   */
  private refAliases = new Map<string, string>()
  /** Whether the page's timers are being held back, as they are in a covered or background window. */
  private throttled = false
  private quietCount = 0
  /** When the agent last did something, for its cursor to follow it onto a new page. */
  private acted = 0
  /**
   * Where the last action aimed and where it actually pressed, for whoever
   * reports it. Only filled while `OPENCODE_BROWSER_TRACE` is on; otherwise it
   * stays undefined and costs nothing.
   */
  trace?: BrowserTrace.Entry

  private constructor(
    readonly id: string,
    readonly targetId: string,
    private connection: CDPTransport,
    private hooks: TabHooks,
  ) {
    this.mainFrame = targetId
  }

  static async attach(id: string, targetId: string, wsUrl: string, hooks: TabHooks = IDLE) {
    const connection = new CDPConnection(wsUrl)
    await connection.connect()
    return Tab.attachTransport(id, targetId, connection, hooks)
  }

  /**
   * Attaches to a tab over a transport that is already connected, such as the
   * one relayed through the browser extension.
   */
  /** Switches on what a tab needs to be followed: page, script, network and log events. */
  private static async enable(send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
    await Promise.all([
      send("Page.enable"),
      send("Runtime.enable"),
      send("Network.enable"),
      send("Log.enable").catch(() => {}),
      // A tab whose window is covered, as the person's own browser is behind
      // opencode, counts as hidden: it stops painting, the live view gets no
      // pictures, the window shows stale half-drawn content when uncovered,
      // and every input waits seconds for a frame that never comes. Emulating
      // focus keeps it rendering as if in front. Detaching undoes it.
      send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {}),
    ])
  }

  static async attachTransport(id: string, targetId: string, connection: CDPTransport, hooks: TabHooks = IDLE) {
    const tab = new Tab(id, targetId, connection, hooks)
    await tab.prepare()
    return tab
  }

  private async prepare() {
    await Tab.enable((method, params) => this.connection.send(method, params))
    // The browser extension restarting drops the debugger, and with it every
    // domain switched on here: the page would go on, but no event would say
    // so, and each wait for a load would sit out its whole timeout. The tab is
    // attached again as it was.
    this.connection.onReattach?.(async (send) => {
      await Tab.enable(send)
      if (this.blockedHosts) await Tab.blockWith(send, this.blockedHosts)
      if (this.castRequest && this.stopCast) await send("Page.startScreencast", this.castRequest).catch(() => {})
    })
    const tree = await this.connection
      .send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree")
      .catch(() => undefined)
    if (tree?.frameTree?.frame?.id) this.mainFrame = tree.frameTree.frame.id

    // The agent's pointer starts in the middle of this page's viewport, so its
    // first move is a glide from somewhere on screen rather than from a corner
    // of a window nobody has this size.
    const view = await this.evaluate<{ width: number; height: number }>(
      "({ width: innerWidth, height: innerHeight })",
    ).catch(() => undefined)
    if (view && view.width > 0 && view.height > 0) {
      this.pointer = { x: Math.round(view.width / 2), y: Math.round(view.height / 2) }
    }

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
      if (SETTLE_TYPES.has(asText(params["type"]))) this.pending.set(id, ++this.counts.request)
      push(this.network, entry)
    })

    this.connection.on("Network.responseReceived", (params) => {
      const entry = this.requestIds.get(asText(params["requestId"]))
      const response = asRecord(params["response"])
      const status = response["status"]
      if (entry && typeof status === "number") entry.status = status
      if (asText(params["type"]) === "Document" && asText(params["frameId"]) === this.mainFrame) {
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(asRecord(response["headers"]))) {
          headers[name.toLowerCase()] = asText(value)
        }
        this.document = {
          url: asText(response["url"]),
          status: typeof status === "number" ? status : 0,
          headers,
          mimeType: asText(response["mimeType"], headers["content-type"] ?? ""),
        }
      }
    })

    this.connection.on("Network.loadingFinished", (params) => {
      const id = asText(params["requestId"])
      this.inflight.delete(id)
      this.pending.delete(id)
    })

    this.connection.on("Network.loadingFailed", (params) => {
      const id = asText(params["requestId"])
      const entry = this.requestIds.get(id)
      if (entry) entry.failure = asText(params["errorText"], "failed")
      this.inflight.delete(id)
      this.pending.delete(id)
    })

    this.connection.on("Page.frameStartedLoading", (params) => {
      if (asText(params["frameId"]) === this.mainFrame) this.counts.started++
    })
    this.connection.on("Page.frameStoppedLoading", (params) => {
      if (asText(params["frameId"]) === this.mainFrame) this.counts.stopped++
    })

    // The owner keeps its address bar and tab titles current from these.
    this.connection.on("Page.frameNavigated", (params) => {
      const frame = asRecord(params["frame"])
      if (frame["parentId"]) return
      const id = asText(frame["id"])
      if (id) this.mainFrame = id
      // A page restored from the back/forward cache comes without a response,
      // so the last one seen no longer describes what is on screen.
      if (this.document && asText(frame["url"]) !== this.document.url) this.document = undefined
      this.hooks.changed()
    })
    this.connection.on("Page.domContentEventFired", () => {
      this.counts.loaded++
      // A new document starts without the overlay. If the agent brought the
      // page here, put its cursor back where it left it so the view does not
      // lose track of it; a page the person opened themselves stays clear.
      if (this.presenting && Date.now() - this.acted < CURSOR_CARRY) {
        void this.cursor("place", `${this.pointer.x}, ${this.pointer.y}`)
      }
    })
    this.connection.on("Page.loadEventFired", () => {
      this.counts.complete++
      this.hooks.changed()
    })

    // While a page shows an alert, a confirm or a "leave this page?" dialog,
    // the browser answers no command on the tab: reading, clicking and even
    // reloading all hang until someone closes it. Nobody may be looking, so it
    // is answered at once, the way the agent's own action meant it: alerts
    // and confirms accepted, leaving allowed, prompts dismissed. The model is
    // told what it said with the next result.
    this.connection.on("Page.javascriptDialogOpening", (params) => {
      const type = asText(params["type"], "alert")
      const accepted = type !== "prompt"
      push(this.dialogs, { type, message: asText(params["message"]).slice(0, 300), accepted })
      void this.connection.send("Page.handleJavaScriptDialog", { accept: accepted }).catch(() => {})
    })

    // A link to a file served as an attachment (a Moodle resource, a PDF with
    // forcedownload) downloads it and leaves the page as it was, so the action
    // looked like it did nothing. The download says what the file was.
    this.connection.on("Page.downloadWillBegin", (params) => {
      push(this.downloads, { url: asText(params["url"]), name: asText(params["suggestedFilename"]), at: Date.now() })
    })
  }

  /** Files the page started downloading since `since`, oldest first. */
  downloadsSince(since: number) {
    return this.downloads.filter((download) => download.at >= since)
  }

  get connected() {
    return this.connection.connected
  }

  /** How many dialogs have been answered and not yet reported, without taking them. */
  get dialogCount() {
    return this.dialogs.length
  }

  /** The dialogs answered since the last call, which are then forgotten. */
  takeDialogs() {
    const dialogs = this.dialogs
    this.dialogs = []
    return dialogs
  }

  /** Whether the agent's cursor is being shown. */
  private get presenting() {
    // A browser window covered by another shows the cursor to no one, so its
    // glide and the human typing pace are only waited out for the live view.
    if (this.throttled && this.hooks.watched && !this.hooks.watched()) return false
    return this.hooks.presenting()
  }

  /** Reports what the agent is doing to whoever is watching. */
  announce(kind: ActivityKind, target?: string) {
    this.acted = Date.now()
    this.hooks.activity({ kind, target: target || undefined, tab: this.id, at: this.acted })
  }

  /**
   * Says that input has just reached the page, so whoever is watching should
   * read where it ended up.
   *
   * A page that renames itself or moves within a single page app tells the
   * browser through target events, and the browser is free to coalesce those
   * while it is busy streaming frames: an action's effect on the address bar
   * could otherwise be missed until some unrelated event came along. The owner
   * debounces this and only reads anything while someone is subscribed, which
   * also gives the page's own handlers time to run first.
   */
  private touched() {
    this.hooks.changed()
  }

  async url() {
    return this.evaluate<string>("document.location.href").catch(() => "about:blank")
  }

  async title() {
    return this.evaluate<string>("document.title").catch(() => "")
  }

  /**
   * The PDF this tab is showing, if it is showing one. Known from the response
   * that served the page, so it holds even once the browser's PDF viewer has
   * taken the tab out of reach.
   */
  get pdf() {
    const document = this.document
    return document && /application\/(x-)?pdf/i.test(document.mimeType) ? document.url : undefined
  }

  /** Evaluates an expression in the page and returns its value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    if (!this.connection.connected) throw new TabGoneError()
    let timer: ReturnType<typeof setTimeout> | undefined
    let off = () => {}
    // Once the main frame commits a new document, the context this runs in is
    // gone; waiting for an answer past a short grace only burns the call timeout.
    const orphaned = new Promise<never>((_, reject) => {
      off = this.connection.on("Page.frameNavigated", (params) => {
        if (asRecord(params["frame"])["parentId"] || timer) return
        timer = setTimeout(() => reject(new PageReplacedError()), ORPHAN_GRACE)
      })
    })
    const result = await Promise.race([
      this.connection.send<EvaluateResult>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }),
      orphaned,
    ])
      .catch((error: unknown) => {
        // The relay gave up on it for the same reason.
        if (error instanceof ReplacedError) throw new PageReplacedError()
        throw error
      })
      .finally(() => {
        off()
        clearTimeout(timer)
      })
    if (result.exceptionDetails) {
      const details = result.exceptionDetails
      const description = details.exception?.description ?? details.text ?? "Evaluation failed"
      const marker = "__OC_REF_ERROR__"
      const marked = description.indexOf(marker)
      // Ref ambiguity is a user-actionable failure, not a page debugging
      // failure, so its injected JavaScript stack would only obscure it.
      if (marked >= 0) throw new EvaluationError(description.slice(marked + marker.length).split("\n")[0]!)
      throw new EvaluationError(description)
    }
    return result.result?.value as T
  }

  /** Calls an arrow-function source string with a JSON argument. */
  private call<T>(source: string, argument: unknown) {
    return this.evaluate<T>(`(${source})(${JSON.stringify(argument)})`)
  }

  /** The in-page expression that resolves a selector, including a snapshotted ref's recovery identity. */
  locate(selector: string) {
    const given = /^\[data-oc-ref="(ref_\d+)"\]$/.exec(selector)?.[1]
    const ref = given ? (this.refAliases.get(given) ?? given) : undefined
    if (!ref) return find(selector, undefined)
    return find(BrowserSnapshot.locator(ref), this.refIdentities.get(ref))
  }

  /**
   * Lets refs the model saw on an earlier page reach the same elements on this
   * one, given as pairs of old and current refs. A ref already standing in for
   * an older one carries that one along.
   */
  alias(pairs: [string, string][]) {
    const moved = new Map(pairs)
    for (const [from, to] of this.refAliases) {
      const next = moved.get(to)
      if (next) this.refAliases.set(from, next)
    }
    for (const [from, to] of pairs) this.refAliases.set(from, to)
    // Only the newest few pages are worth answering for.
    for (const key of this.refAliases.keys()) {
      if (this.refAliases.size <= ALIAS_MAX) break
      this.refAliases.delete(key)
    }
  }

  /** What a ref stood for when the outline was read: its role and name, among others. */
  identityOf(ref: string) {
    const normalized = ref.startsWith("ref_") ? ref : `ref_${ref}`
    return this.refIdentities.get(this.refAliases.get(normalized) ?? normalized)
  }

  /** Commands that took unusually long since the last call. */
  takeSlow(): SlowCall[] {
    return this.connection.takeSlow?.() ?? []
  }

  /**
   * An expression that drives the in-page cursor overlay, installing it on
   * first use. `args` is a JavaScript argument list, so it can refer to values
   * of a script it rides along in. It never throws, and a failure yields 0.
   */
  private cursorCall(method: string, args = "") {
    const { x, y } = this.pointer
    return `(() => { try { return (${BrowserCursor.SCRIPT})(${x}, ${y}).${method}(${args}) || 0 } catch (error) { return 0 } })()`
  }

  /** Drives the in-page cursor overlay on its own. Never fails. */
  private cursor(method: string, args = "") {
    return this.evaluate(this.cursorCall(method, args)).catch(() => {})
  }

  /**
   * Reads the page outline. Refs already on the page are kept, and new ones
   * continue from the highest this tab has handed out.
   */
  async snapshot(options: SnapshotOptions = {}, retry = true): Promise<SnapshotResult> {
    const result = await this.call<SnapshotResult>(BrowserSnapshot.SCRIPT, {
      ...options,
      refStart: this.refMax,
      // So an element the page rebuilt keeps the ref the model already has.
      known: Object.fromEntries(this.refIdentities),
    }).catch((error: unknown) => {
      // Reading is harmless to repeat, and the new page is what was wanted.
      if (retry && error instanceof PageReplacedError) return undefined
      throw error
    })
    if (!result) return this.snapshot(options, false)
    this.refMax = Math.max(this.refMax, number(result.lastRef))
    if (result.documentId && result.documentId !== this.refDocument) this.refIdentities.clear()
    this.refDocument = result.documentId
    for (const [ref, identity] of Object.entries(result.identities ?? {})) this.refIdentities.set(ref, identity)
    return result
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
    const mark = this.mark()
    const result = await this.connection.send<NavigateResult>("Page.navigate", { url })
    if (result?.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`)
    await this.arrived(mark, waitUntil, timeout)
  }

  async reload(waitUntil: WaitUntil, timeout: number) {
    this.announce("reload")
    const mark = this.mark()
    await this.connection.send("Page.reload")
    await this.arrived(mark, waitUntil, timeout)
  }

  /** Moves `delta` entries through history; negative goes back. */
  async history(delta: number, waitUntil: WaitUntil, timeout: number) {
    const { currentIndex, entries } = await this.connection.send<NavigationHistory>("Page.getNavigationHistory")
    const index = currentIndex + delta
    if (index < 0 || index >= entries.length) {
      throw new Error(delta < 0 ? "No page to go back to." : "No page to go forward to.")
    }
    this.announce(delta < 0 ? "back" : "forward", entries[index].url)
    const mark = this.mark()
    await this.connection.send("Page.navigateToHistoryEntry", { entryId: entries[index].id })
    await this.arrived(mark, waitUntil, timeout)
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
   * Waits for a navigation that was just asked for to arrive.
   *
   * Counted from events rather than waited for as one. Waiting for the next
   * `domContentEventFired` sounds right and is a trap: a page restored from the
   * back/forward cache is shown again without firing it, a navigation to the
   * same address with a different fragment never leaves the document, and a
   * reload of a page that is already idle can be over before the wait is even
   * installed. In each of those the wait ran to the tool's whole timeout — in
   * real sessions, a median of 31 seconds for one "back", 20 for a reload.
   * Here, the frame having stopped loading ends the wait just as well as the
   * document event, and a navigation that never starts is noticed in
   * {@link NAVIGATION_START} instead of costing the full timeout.
   */
  private async arrived(mark: Mark, waitUntil: WaitUntil, timeout: number) {
    const deadline = Date.now() + Math.min(timeout, NAVIGATION_MAX)
    const reached = () =>
      (waitUntil === "domcontentloaded" ? this.counts.loaded > mark.loaded : this.counts.complete > mark.complete) ||
      this.counts.stopped > mark.stopped
    await this.until(() => this.navigatingSince(mark) || reached(), Math.min(deadline, Date.now() + NAVIGATION_START))
    if (this.navigatingSince(mark) || reached()) await this.until(reached, deadline)
    if (waitUntil === "networkidle") await this.waitForIdle(Math.max(0, deadline - Date.now()))
    await this.quiet()
  }

  /**
   * Waits for the page to settle, for a navigation this tab did not start, such
   * as one the page itself made. `networkidle` is the useful one for single
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

  /** Where the page's navigation counters stand, to measure an action against. */
  mark(): Mark {
    return { ...this.counts }
  }

  /** Whether a request that ends in a re-render started since the mark and is still running. */
  private busySince(mark: Mark) {
    for (const started of this.pending.values()) if (started > mark.request) return true
    return false
  }

  private navigatingSince(mark: Mark) {
    return this.counts.started > mark.started
  }

  /** Whether the page started loading another document since the mark. */
  navigatedSince(mark: Mark) {
    return this.navigatingSince(mark)
  }

  /** Polls until `done`, the deadline, or the tab being lost, which nothing would ever report. */
  private async until(done: () => boolean, deadline: number) {
    while (!done() && this.connected && Date.now() < deadline) await sleep(25)
  }

  /**
   * Waits until the page's DOM has been still for a moment, which is when a
   * re-render is done, frames of the same site included, since that is where
   * embedded activities answer. Resolves early if the page navigates away
   * mid-wait. A tab in the background runs its timers late, so the wait is
   * also capped from this side.
   *
   * A window covered by another one is "hidden" to the browser, which then runs
   * the page's timers about once a second: the in-page wait below never ends on
   * its own, and every action paid the whole cap, two or three times over. Once
   * that is seen, the clock moves here and the page is only asked when it last
   * changed, which a hidden page answers straight away.
   */
  async quiet(quiet = QUIET, max = QUIET_MAX) {
    if (!this.connected) return
    if (this.throttled) return this.quietFromHere(quiet, max)
    let answered = false
    const still = this.evaluate(
      `new Promise((resolve) => {
        const start = performance.now()
        let last = start
        const observer = new MutationObserver(() => { last = performance.now() })
        const watch = (doc) => {
          observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true })
          for (const frame of doc.querySelectorAll("iframe, frame")) {
            try {
              if (frame.contentDocument) watch(frame.contentDocument)
            } catch (error) {}
          }
        }
        watch(document)
        const tick = () => {
          const now = performance.now()
          if (now - last >= ${quiet} || now - start >= ${max}) {
            observer.disconnect()
            resolve(true)
          } else setTimeout(tick, 20)
        }
        setTimeout(tick, 20)
      })`,
    )
      .then(() => {
        answered = true
      })
      .catch(() => {})
    await Promise.race([still, sleep(max + 150)])
    // The page's own clock could not even reach the cap: its timers are held back.
    if (!answered && this.connected) this.throttled = true
  }

  /** {@link quiet} timed from here, for a page whose timers the browser holds back. */
  private async quietFromHere(quiet: number, max: number) {
    const key = `__ocQuiet${++this.quietCount}`
    const deadline = Date.now() + max
    const read = (install: boolean) =>
      this.evaluate<{ idle: number; hidden: boolean } | null>(
        `(() => {
          const now = performance.now()
          let state = window[${JSON.stringify(key)}]
          if (!state && ${install}) {
            state = window[${JSON.stringify(key)}] = { last: now, observer: new MutationObserver(() => { state.last = performance.now() }) }
            const watch = (doc) => {
              state.observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true })
              for (const frame of doc.querySelectorAll("iframe, frame")) {
                try {
                  if (frame.contentDocument) watch(frame.contentDocument)
                } catch (error) {}
              }
            }
            watch(document)
          }
          if (!state) return null
          return { idle: now - state.last, hidden: document.visibilityState === "hidden" }
        })()`,
      ).catch(() => null)
    const first = await read(true)
    // Visible again: the page's own clock is good, and cheaper.
    if (first && !first.hidden) this.throttled = false
    let state = first
    while (state && state.idle < quiet && Date.now() < deadline && this.connected) {
      await sleep(Math.min(QUIET_POLL, Math.max(10, quiet - state.idle)))
      state = await read(false)
    }
    void this.evaluate(
      `(() => { const state = window[${JSON.stringify(key)}]; if (state) { state.observer.disconnect(); delete window[${JSON.stringify(key)}] } })()`,
    ).catch(() => {})
  }

  /**
   * Runs page actions one at a time for this tab. When a model emits several
   * tool calls together the harness runs them at once, and without this their
   * mouse and key events interleave: a click lands where a scroll just moved
   * the page, or a verdict is read off the wrong action. Reads (snapshots) are
   * left free; only the acting is queued.
   */
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.actionChain.then(fn, fn)
    this.actionChain = result.then(
      () => {},
      () => {},
    )
    return result
  }

  /**
   * Waits for whatever an action set off to finish: a request to come back, a
   * navigation to reach DOMContentLoaded, and the DOM to stop changing. A click
   * that only toggles something is done in a fraction of a second, instead of
   * waiting out a load event that never comes.
   */
  async settle(mark: Mark, timeout: number) {
    const start = Date.now()
    try {
      // The DOM going still and a request going out are two different answers
      // to "what did that do", and whichever comes first says what to wait for
      // next. Waiting the DOM out first cost the wait for it on every click
      // that sends something — an answer being marked, a form being posted —
      // before the request it set off was even looked at.
      await Promise.race([
        this.quiet(),
        this.until(() => this.busySince(mark) || this.navigatingSince(mark), start + QUIET_MAX),
      ])
      if (!this.navigatingSince(mark) && this.busySince(mark)) {
        await this.until(() => !this.busySince(mark) || this.navigatingSince(mark), start + REQUEST_MAX)
        if (!this.navigatingSince(mark)) await this.quiet()
      }
      if (!this.navigatingSince(mark)) return
      // A navigation that turns into a download stops without ever loading.
      await this.until(
        () => this.counts.loaded > mark.loaded || this.counts.stopped > mark.stopped,
        start + Math.min(timeout, NAVIGATION_MAX),
      )
      await this.quiet()
    } finally {
      // The page has stopped moving, so whoever is watching should see where
      // it ended up. Title and address changes otherwise only reach the live
      // view through target events, and the browser is free to coalesce those
      // while it is busy streaming frames: an action that renamed the page or
      // took it somewhere could leave a stale address bar behind until the
      // next unrelated event. Reading it here costs nothing, since the owner
      // debounces and only reads at all while someone is subscribed.
      this.hooks.changed()
    }
  }

  /**
   * Finds an element and measures it: where it sits, where a click reaches it,
   * and a short name for the live view's caption. Field values are never used
   * as the name, so a password cannot end up there. While someone watches, the
   * cursor sets off for it in the same round trip, and `duration` says how long
   * that takes.
   */
  private async target(
    selector: string,
    options: { glide?: boolean; reach?: boolean; after?: number } = {},
  ): Promise<Target> {
    const glide = options.glide ?? true
    const cursor =
      glide && this.presenting ? this.cursorCall("glide", "f.x + f.ox, f.y + f.oy, f.x, f.y, f.width, f.height") : "0"
    // A wait before measuring is spent inside the page rather than here, so it
    // overlaps the round trip instead of following it. Through the extension,
    // where every command is a trip out to the browser and back, that is the
    // difference between the cursor's glide costing its own time and costing
    // nothing at all.
    const glideWait = Math.max(0, Math.round(options.after ?? 0))
    // A page whose timers are held back would sleep a whole second instead.
    if (this.throttled && glideWait > 0) await sleep(glideWait)
    const after = this.throttled ? 0 : glideWait
    const found = await this.evaluate<(Measured & { duration: number }) | null>(
      `(async () => {
        ${after > 0 ? `await new Promise((resolve) => setTimeout(resolve, ${after}))` : ""}
        const el = ${this.locate(selector)}
        if (!el) return null
        const f = (${MEASURE})(el, ${JSON.stringify(SPOTS)})
        f.duration = ${cursor}
        return f
      })()`,
    )
    if (!found) throw new ElementNotFoundError(selector)
    const { name, checked, draggable, duration, ox, oy, cover, view, ...rect } = found
    if (cover && (options.reach ?? true)) throw new CoveredError(name ? `"${name}"` : selector, cover)
    return {
      rect,
      point: { x: rect.x + ox, y: rect.y + oy },
      name,
      checked,
      draggable,
      duration: number(duration),
      view,
    }
  }

  async exists(selector: string) {
    return this.evaluate<boolean>(`${this.locate(selector)} !== null`)
  }

  /**
   * Brings the pointer onto a target and says where the press must land.
   *
   * The rect measured before the cursor set off is only a guess by the time it
   * arrives: in between, the page can re-render, animate, scroll, collapse a
   * sticky header, or drop the element entirely. So the element is measured
   * again here, and it is that second measurement the press uses. A page that
   * moved under the agent is clicked where it is now; one that took the element
   * away fails before a single input event is sent, rather than clicking
   * whatever slid into the old spot.
   *
   * The page still only ever sees one move, so behaviour does not depend on
   * being watched. The cursor is corrected towards the final point without
   * being waited for: it is a drawing, and precision never waits on it.
   */
  private async point(selector: string, target: Target, options: { reach?: boolean } = {}) {
    const fresh = await this.target(selector, {
      glide: false,
      reach: options.reach,
      after: target.duration,
    }).catch((error: unknown) => {
      if (error instanceof ElementNotFoundError) {
        throw new ElementNotFoundError(
          selector,
          `${target.name ? `"${target.name}"` : selector} was on the page when the action started, but was gone before the click could land, so nothing was clicked.`,
        )
      }
      throw error
    })
    const { x, y } = fresh.point
    const drift = Math.hypot(x - target.point.x, y - target.point.y)
    this.pointer = { x, y }
    // The element moved after the cursor set off for it, so the drawing is
    // sent after it, outline and all. Not waited for: the press has the right
    // coordinates either way, and precision never waits on a picture.
    if (drift > CURSOR_DRIFT && this.presenting) {
      const box = fresh.rect
      void this.cursor("glide", `${x}, ${y}, ${box.x}, ${box.y}, ${box.width}, ${box.height}`)
    }
    await this.connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" })
    if (BrowserTrace.enabled) {
      this.trace = {
        requested: this.trace?.requested ?? selector,
        element: fresh.name || undefined,
        initial: target.rect,
        cursor: target.duration,
        revalidated: fresh.rect,
        final: { x, y },
        drift,
        viewport: { width: fresh.view.width, height: fresh.view.height },
        scroll: { x: fresh.view.scrollX, y: fresh.view.scrollY },
        dpr: fresh.view.dpr,
        cdp: "Input.dispatchMouseEvent",
      }
    }
    return { x, y, target: fresh }
  }

  private async pressAt(
    x: number,
    y: number,
    button: "left" | "right",
    clickCount: number,
    modifiers: readonly Modifier[] = [],
  ) {
    const presenting = this.presenting
    // Commands on one tab run in order, so the ripple is under way before the
    // press without the press having to wait for it.
    if (presenting) void this.cursor("click")
    const held = mask(modifiers)
    await Promise.all([
      this.connection.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        clickCount,
        buttons: button === "right" ? 2 : 1,
        modifiers: held,
      }),
      this.connection.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        clickCount,
        buttons: 0,
        modifiers: held,
      }),
    ])
    this.touched()
    if (presenting) await sleep(CLICK_SETTLE)
  }

  /**
   * Clicks an element, optionally with keys held.
   *
   * The modifiers ride on the mouse event itself rather than being pressed and
   * released around it, because that is how the browser is told about them: a
   * dispatched key press leaves no state behind for a later event to pick up.
   * So a control-click is one event that says control was down.
   */
  async click(
    selector: string,
    button: "left" | "right" = "left",
    clickCount = 1,
    modifiers: readonly Modifier[] = [],
  ) {
    const target = await this.target(selector)
    this.announce(clickCount > 1 ? "double_click" : button === "right" ? "right_click" : "click", target.name)
    const { x, y } = await this.point(selector, target)
    await this.pressAt(x, y, button, clickCount, modifiers)
  }

  /**
   * Presses the button over an element and leaves it down, for a gesture put
   * together by hand. Whatever follows happens with the button held, and
   * nothing releases it but `mouseUp`.
   */
  async mouseDown(
    selector: string | undefined,
    button: "left" | "right" = "left",
    modifiers: readonly Modifier[] = [],
  ) {
    const target = selector ? await this.target(selector) : undefined
    this.announce("drag", target?.name)
    const point = selector && target ? await this.point(selector, target) : this.pointer
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button,
      clickCount: 1,
      buttons: button === "right" ? 2 : 1,
      modifiers: mask(modifiers),
    })
    this.pointer = { x: point.x, y: point.y }
    this.touched()
  }

  /** Lets the button go, where the pointer is or over another element. */
  async mouseUp(selector: string | undefined, button: "left" | "right" = "left", modifiers: readonly Modifier[] = []) {
    const target = selector ? await this.target(selector, { reach: false }) : undefined
    this.announce("drag", target?.name)
    const point = selector && target ? await this.point(selector, target, { reach: false }) : this.pointer
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button,
      clickCount: 1,
      buttons: 0,
      modifiers: mask(modifiers),
    })
    this.pointer = { x: point.x, y: point.y }
    this.touched()
  }

  /**
   * Drags one element onto another with the button held down, moving in steps
   * so that a page watching the pointer sees a drag rather than a jump.
   */
  async drag(from: string, to: string) {
    const source = await this.target(from)
    this.announce("drag", source.name)
    const start = await this.point(from, source)
    if (source.draggable) {
      const supported = await this.connection.send("Input.setInterceptDrags", { enabled: true }).then(
        () => true,
        () => false,
      )
      if (supported) {
        const native = await this.dragNative(start, to).then(
          () => true,
          () => false,
        )
        if (native) return
      }
    }
    await this.dragMouse(start, to)
  }

  /** Native HTML drag and drop carries browser-created DragData to the destination. */
  private async dragNative(start: { x: number; y: number }, to: string) {
    let destination: Target | undefined
    try {
      await this.connection.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: start.x,
        y: start.y,
        button: "left",
        clickCount: 1,
        buttons: 1,
      })
      // Picking a sortable item up can reflow the list, so the destination
      // must be measured only after the page has seen the press.
      destination = await this.target(to, { glide: false, reach: false })
      const intercepted = this.connection.once("Input.dragIntercepted", 2000)
      await this.connection.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: destination.point.x,
        y: destination.point.y,
        button: "left",
        buttons: 1,
      })
      const event = await intercepted
      const data = event["data"]
      if (!data || typeof data !== "object") throw new Error("The browser did not provide drag data for this element.")
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await this.connection.send("Input.dispatchDragEvent", {
          type,
          x: destination.point.x,
          y: destination.point.y,
          data,
        })
      }
    } finally {
      const end = destination?.point ?? start
      await Promise.all([
        this.connection.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: end.x,
          y: end.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        }),
        this.connection.send("Input.setInterceptDrags", { enabled: false }),
      ])
    }
    if (!destination) return
    this.pointer = { ...destination.point }
    this.touched()
  }

  /** Mouse movement remains the right protocol for sortables, sliders, canvases and maps. */
  private async dragMouse(start: { x: number; y: number }, to: string) {
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: start.x,
      y: start.y,
      button: "left",
      clickCount: 1,
      buttons: 1,
    })
    // Picking a sortable item up can reflow the list, so the destination
    // must be measured only after the page has seen the press.
    const destination = await this.target(to, { glide: false, reach: false }).catch(async (error: unknown) => {
      await this.connection.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: start.x,
        y: start.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      })
      throw error
    })
    const presenting = this.presenting
    for (let step = 1; step <= DRAG_STEPS; step++) {
      const x = start.x + ((destination.point.x - start.x) * step) / DRAG_STEPS
      const y = start.y + ((destination.point.y - start.y) * step) / DRAG_STEPS
      await this.connection.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 1,
      })
      if (presenting) {
        this.pointer = { x, y }
        void this.cursor("place", `${x}, ${y}`)
        await sleep(TYPE_TICK)
      }
    }
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: destination.point.x,
      y: destination.point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    })
    this.pointer = { ...destination.point }
    this.touched()
  }

  /**
   * Puts a file into a file input.
   *
   * There is no way to type a path into one: the browser fills it itself from
   * what the person picked, and this is the protocol's way of saying what that
   * was. The page is told the same way it would be by a person choosing it,
   * so whatever it does on change happens.
   */
  async upload(selector: string, files: string[]) {
    const target = await this.target(selector, { glide: false, reach: false })
    this.announce("upload", target.name)
    await this.connection.send("DOM.enable").catch(() => {})
    const handle = await this.connection.send<{ result?: { objectId?: string } }>("Runtime.evaluate", {
      expression: this.locate(selector),
      returnByValue: false,
    })
    const objectId = handle.result?.objectId
    if (!objectId) throw new ElementNotFoundError(selector)
    const direct = await this.connection
      .send("DOM.setFileInputFiles", { files, objectId })
      .then(
        () => true,
        () => false,
      )
      .finally(() => this.connection.send("Runtime.releaseObject", { objectId }).catch(() => {}))
    // Through the person's own browser the extension is not allowed to name a
    // file on disk (unless they gave it access to file URLs), so the files are
    // read here and handed to the input from inside the page instead, the way
    // a page's own drag and drop would.
    if (!direct) await this.evaluate(`(${GIVE_FILES})(${this.locate(selector)}, ${JSON.stringify(await readUploads(files))})`)
    this.touched()
  }

  async hover(selector: string) {
    const target = await this.target(selector)
    this.announce("hover", target.name)
    await this.point(selector, target)
  }

  /** Focuses an element unless it or something inside it already has focus. Focusing scrolls it into view. */
  async focus(selector: string) {
    const ok = await this.evaluate<boolean>(
      `(() => {
        const el = ${this.locate(selector)}
        if (!el) return false
        const active = el.ownerDocument.activeElement
        if (active && (active === el || el.contains(active))) return true
        el.focus()
        return true
      })()`,
    )
    if (!ok) throw new ElementNotFoundError(selector)
  }

  /**
   * Inserts text at the caret. Watched, it arrives a few characters at a time
   * so typing is visible, but never takes longer than the typing budget, so
   * nobody waits on a paragraph being typed out.
   */
  private async insert(text: string) {
    if (!this.presenting) {
      await this.connection.send("Input.insertText", { text })
      return
    }
    // Sent without waiting on each reply: they run in order anyway, and the
    // pause between chunks is what makes the typing visible.
    const sent: Promise<unknown>[] = []
    for (const chunk of chunks(Array.from(text))) {
      sent.push(this.connection.send("Input.insertText", { text: chunk.join("") }))
      await sleep(TYPE_TICK)
    }
    await Promise.all(sent)
  }

  /**
   * Replaces a field's value.
   *
   * The fast way is to select what is there and insert the new text in one go,
   * which is what this does. It is not always enough: inserting text fires no
   * key events, and a field that masks a phone number or rewrites what it is
   * given as it is typed hears nothing and either ignores the insert or keeps
   * the raw text. Those fields say so in their markup, and are typed into key
   * by key instead; a field that quietly swallowed the insert is typed into on
   * a second pass, once, which is the case a framework's controlled input
   * produces. The text is never assigned to `value` directly, because that
   * notifies nothing at all.
   */
  async fill(selector: string, text: string) {
    const target = await this.target(selector)
    this.announce("fill", target.name)
    const { x, y } = await this.point(selector, target)
    await this.pressAt(x, y, "left", 1)
    // The click normally focused the field. In one round trip, make sure of it
    // and select what is there, so the insert below replaces it. A ref on a
    // wrapper whose field is inside it selects in that field.
    const found = await this.evaluate<{ selected: boolean; masked: boolean; type: string } | null>(
      `(() => {
        const el = ${this.locate(selector)}
        if (!el) return null
        // A field inside a frame has focus in its own document.
        const doc = el.ownerDocument
        let field = doc.activeElement
        if (!field || (field !== el && !el.contains(field))) {
          el.focus()
          field = doc.activeElement
        }
        if (!field) return { selected: false, masked: false, type: "" }
        // What a field that rewrites what it is given looks like from outside.
        const attr = (name) => (field.getAttribute ? field.getAttribute(name) : null)
        const type = field.tagName === "INPUT" ? (attr("type") || "text").toLowerCase() : ""
        const masked =
          /^(numeric|tel|decimal)$/i.test(attr("inputmode") || "") ||
          /^(tel)$/i.test(type) ||
          attr("pattern") !== null ||
          attr("data-mask") !== null ||
          attr("data-imask") !== null ||
          /mask/i.test(field.className || "")
        if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
          if (typeof field.select !== "function") return { selected: false, masked: masked, type: type }
          field.select()
          return { selected: true, masked: masked, type: type }
        }
        if (field.isContentEditable) {
          const range = document.createRange()
          range.selectNodeContents(field)
          const selection = doc.defaultView.getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
          return { selected: true, masked: masked, type: "" }
        }
        return { selected: false, masked: masked, type: type }
      })()`,
    )
    if (found === null) throw new ElementNotFoundError(selector)

    // A date, time, range or colour picker takes no free text: typing into it
    // leaves it empty. Its value is set directly, the one way that works, and
    // the model's dd/mm/yyyy is turned into the yyyy-mm-dd the field wants.
    if (text && /^(date|datetime-local|month|week|time|range|color)$/.test(found.type)) {
      const value = normalizeFieldValue(found.type, text)
      if (await this.setValueDirect(selector, value)) return { typed: false }
      // It refused the value; fall through and let the normal path try.
    }

    if (!found.selected) await this.key("Control+a")

    if (!text) {
      await this.key("Delete")
      await this.notifyInput(selector)
      return { typed: false }
    }
    if (found.masked) {
      // It said it rewrites what it is given, so give it keys from the start.
      // Real keys notify the page by themselves; a synthetic input event on top
      // of them is one the page never asked for, and a controlled field can
      // take it for a change it did not make.
      await this.key("Delete")
      await this.typeText(text)
      return { typed: true }
    }

    await this.insert(text)
    await this.notifyInput(selector)
    // A controlled input that only trusts key events throws the insert away.
    // It has cost one round trip to find out, and typing it is the answer.
    if (await this.isEmpty(selector)) {
      await this.key("Control+a")
      await this.typeText(text)
      return { typed: true }
    }
    return { typed: false }
  }

  /**
   * Sets a field's value the way a script would, through the prototype's value
   * setter so a framework's controlled input notices, then fires input and
   * change. This is the only thing a date or range picker accepts, since they
   * cannot be typed into. Returns whether the value stuck.
   */
  private setValueDirect(selector: string, value: string) {
    return this.evaluate<boolean>(
      `(() => {
        const el = ${this.locate(selector)}
        if (!el) return false
        const doc = el.ownerDocument
        let field = doc.activeElement
        if (!field || (field !== el && !el.contains(field))) field = el
        const view = doc.defaultView || window
        const proto = field.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, "value")
        if (setter && setter.set) setter.set.call(field, ${JSON.stringify(value)})
        else field.value = ${JSON.stringify(value)}
        field.dispatchEvent(new Event("input", { bubbles: true }))
        field.dispatchEvent(new Event("change", { bubbles: true }))
        return String(field.value).length > 0
      })()`,
    ).catch(() => false)
  }

  /** Tells the page its field changed, for anything listening on the wrapper rather than the field. */
  private notifyInput(selector: string) {
    return this.evaluate(
      `(() => {
        const el = ${this.locate(selector)}
        if (!el) return
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
      })()`,
    ).catch(() => {})
  }

  /**
   * Whether the field came out empty. Only its emptiness is read back, never
   * its text, so a password can be known to have been refused without leaving
   * the page.
   */
  private isEmpty(selector: string) {
    return this.evaluate<boolean>(
      `(() => {
        const el = ${this.locate(selector)}
        if (!el) return false
        const doc = el.ownerDocument
        let field = doc.activeElement
        if (!field || (field !== el && !el.contains(field))) field = el
        const value = typeof field.value === "string" ? field.value : field.isContentEditable ? field.innerText : ""
        return String(value).trim().length === 0
      })()`,
    ).catch(() => false)
  }

  /** Types character by character, which is what triggers autocomplete. */
  async type(selector: string | undefined, text: string) {
    if (selector) {
      const target = await this.target(selector)
      this.announce("type", target.name)
      const { x, y } = await this.point(selector, target)
      await this.pressAt(x, y, "left", 1)
      await this.focus(selector)
    } else {
      this.announce("type")
      if (this.presenting) void this.cursor("busy")
    }

    await this.typeText(text)
  }

  /**
   * Sends text one key at a time, as a person's keyboard would.
   *
   * Each character goes as the key it comes from, with its `code` and virtual
   * key code, because that is what a mask, an autocomplete or an editor reads
   * off the event. Sent as bare text they all arrive with an empty code and a
   * key code of zero, and those pages do nothing with them.
   */
  private async typeText(text: string) {
    const presenting = this.presenting
    const chars = Array.from(text)
    // Keys are sent without waiting on each reply; they are delivered in order.
    const sent: Promise<unknown>[] = []
    for (const chunk of presenting ? chunks(chars) : [chars]) {
      for (const char of chunk) {
        const key = describeChar(char)
        const common = {
          key: key.key,
          code: key.code,
          windowsVirtualKeyCode: key.keyCode,
          nativeVirtualKeyCode: key.keyCode,
          modifiers: key.shift ? MODIFIERS["shift"]! : 0,
        }
        sent.push(
          this.connection.send("Input.dispatchKeyEvent", {
            ...common,
            type: "keyDown",
            text: char,
            unmodifiedText: char,
          }),
        )
        sent.push(this.connection.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" }))
      }
      if (presenting) await sleep(TYPE_TICK)
    }
    await Promise.all(sent)
    this.touched()
  }

  async press(name: string, selector?: string) {
    this.announce("press", name)
    if (selector) await this.focus(selector)
    else if (this.presenting) void this.cursor("busy")
    await this.key(name)
  }

  /** Sends one key or shortcut, without reporting it as an action of its own. */
  private async key(name: string) {
    const key = describeKey(name)
    await Promise.all([
      this.connection.send("Input.dispatchKeyEvent", {
        type: key.text ? "keyDown" : "rawKeyDown",
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        nativeVirtualKeyCode: key.keyCode,
        modifiers: key.modifiers,
        ...(key.text ? { text: key.text } : {}),
      }),
      this.connection.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        nativeVirtualKeyCode: key.keyCode,
        modifiers: key.modifiers,
      }),
    ])
    this.touched()
  }

  async select(selector: string, value: string) {
    const target = await this.target(selector)
    this.announce("select", target.name)
    await this.point(selector, target)
    if (this.presenting) void this.cursor("click")
    const ok = await this.evaluate<boolean>(
      `(() => {
        const el = ${this.locate(selector)}
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
    const target = await this.target(selector)
    if (target.checked === checked) return
    this.announce(checked ? "check" : "uncheck", target.name)
    const { x, y } = await this.point(selector, target)
    await this.pressAt(x, y, "left", 1)
  }

  /**
   * Scrolls, the way a wheel does.
   *
   * A script `scrollBy` moves the scrollbar and tells nobody: pages that take
   * the wheel over themselves - smooth scrolling libraries, virtualised lists,
   * carousels, maps - never hear about it and do not move, while the tool
   * reported success. So the wheel is turned where the pointer is, which is
   * what a person does and what those pages listen for, and the script is kept
   * only for when the wheel moved nothing.
   *
   * Either way the scroll positions are read before and after, so "nothing
   * moved" is something the model is told rather than something it has to
   * guess from an unchanged outline.
   */
  async scroll(selector: string | undefined, x: number, y: number) {
    this.announce("scroll")
    const where = await this.wheelPoint(selector)
    if (!where) throw new ElementNotFoundError(selector!)
    if (this.presenting) {
      this.pointer = where.point
      void this.cursor("move", `${where.point.x}, ${where.point.y}, ${CURSOR_CATCHUP}`)
    }

    const before = await this.scrollState(selector, where.point)
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: where.point.x,
      y: where.point.y,
      deltaX: x,
      deltaY: y,
    })
    await this.scrollSettled()
    let after = await this.scrollState(selector, where.point)
    let method: "wheel" | "script" = "wheel"

    if (!moved(before, after)) {
      // Nothing under the pointer took the wheel. An element that scrolls only
      // through its own API, or one the pointer cannot reach, still moves this
      // way, so it is worth one try before reporting that nothing happened.
      method = "script"
      await this.evaluate(
        `(() => {
          const el = ${selector ? this.locate(selector) : "window"}
          if (el) el.scrollBy({ left: ${x}, top: ${y}, behavior: "auto" })
        })()`,
      ).catch(() => {})
      await this.scrollSettled()
      after = await this.scrollState(selector, where.point)
    }

    return { moved: moved(before, after), method }
  }

  /** Where to turn the wheel: over the element, or over the middle of the page. */
  private async wheelPoint(selector: string | undefined) {
    if (!selector) {
      const view = await this.viewport()
      return { point: { x: Math.round(view.width / 2), y: Math.round(view.height / 2) } }
    }
    // Reaching past a cover does not matter for a wheel; being on screen does.
    const target = await this.target(selector, { glide: false, reach: false }).catch(() => undefined)
    if (!target) return undefined
    return { point: target.point }
  }

  /**
   * Enough of where the page stands to tell whether it moved: the window's
   * scroll, each ancestor's up from the element, since the scroll may belong to
   * a box around it rather than to the page, and where two things actually sit
   * on screen, because a page that hijacks the wheel moves its content with a
   * transform and never touches a scroll position at all.
   */
  private scrollState(selector: string | undefined, point: { x: number; y: number }) {
    return this.evaluate<number[]>(
      `(() => {
        const out = [scrollX, scrollY]
        let node = ${selector ? this.locate(selector) : "document.scrollingElement"}
        while (node && node.nodeType === 1) {
          out.push(node.scrollLeft, node.scrollTop)
          node = node.parentElement
        }
        const at = (el) => {
          if (!el || !el.getBoundingClientRect) return out.push(0, 0)
          const r = el.getBoundingClientRect()
          out.push(Math.round(r.top * 10), Math.round(r.left * 10))
        }
        at(document.body)
        at(document.elementFromPoint(${point.x}, ${point.y}))
        return out
      })()`,
    ).catch(() => [])
  }

  /** Waits for the page to stop scrolling, and never for long. */
  private async scrollSettled() {
    const stopped = this.evaluate(
      `new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          resolve(true)
        }
        addEventListener("scrollend", finish, { once: true })
        setTimeout(finish, ${SCROLL_SETTLE})
      })`,
    ).catch(() => {})
    await Promise.race([stopped, sleep(SCROLL_SETTLE + 150)])
  }

  /** Polls until an element is visible, or until `text` appears on the page. */
  async waitFor(input: { selector?: string; text?: string }, timeout: number) {
    this.announce("wait", input.text)
    const start = Date.now()
    const deadline = start + timeout
    // 0: not on the page, 1: there but not yet visible, 2: visible.
    const probe = input.selector
      ? `(() => {
          const el = ${this.locate(input.selector)}
          if (!el) return 0
          const r = el.getBoundingClientRect()
          return (r.width > 0 && r.height > 0) ? 2 : 1
        })()`
      : `((${TEXT_IN_FRAMES})(document).includes(${JSON.stringify(input.text ?? "")}) ? 2 : 0)`

    // A ref that has not shown up within the grace period is not coming: the
    // page renumbered it, so it will never match again, and waiting the whole
    // timeout out is dead time. A plain CSS selector or text may still appear
    // as the page loads, so those keep waiting the full timeout.
    const isRef = /^\[data-oc-ref="ref_\d+"\]$/.test(input.selector ?? "")
    const grace = Math.min(timeout, 2500)
    let everExisted = false
    while (Date.now() < deadline) {
      const state = await this.evaluate<number>(probe).catch(() => 0)
      if (state === 2) return
      if (state >= 1) everExisted = true
      if (isRef && !everExisted && Date.now() - start >= grace) break
      await sleep(150)
    }
    throw new Error(
      input.selector
        ? isRef && !everExisted
          ? `${input.selector} is not on the page`
          : `${input.selector} did not become visible within ${timeout}ms`
        : `"${input.text}" did not appear within ${timeout}ms`,
    )
  }

  /**
   * Where the page is scrolled to and how big its viewport is, in CSS pixels,
   * with the screen's pixel density. Read fresh every time, because anything
   * that measures an element may have scrolled the page to reach it.
   */
  private viewport() {
    return this.evaluate<{ x: number; y: number; width: number; height: number; ratio: number }>(
      `(() => {
        const v = window.visualViewport
        return {
          x: v ? v.pageLeft : scrollX,
          y: v ? v.pageTop : scrollY,
          width: v ? v.width : innerWidth,
          height: v ? v.height : innerHeight,
          ratio: devicePixelRatio || 1,
        }
      })()`,
    )
  }

  /**
   * A JPEG for the model, in CSS pixels whatever the screen's density, which
   * keeps it small on its way through the extension and to the model. The
   * cursor overlay is hidden so the model sees only the page.
   */
  /**
   * A screenshot of the viewport with each element the outline gave a ref
   * drawn over: a box and its number, so a model that sees images can point at
   * what it sees by ref instead of guessing. Elements covered by something
   * else are left unmarked. Returns the picture and the refs that were marked.
   */
  async markedScreenshot() {
    const marked = await this.evaluate<string[]>(MARKS_ON).catch(() => [] as string[])
    try {
      return { image: await this.screenshot(), marked }
    } finally {
      await this.evaluate(MARKS_OFF).catch(() => {})
    }
  }

  async screenshot(options: { selector?: string; fullPage?: boolean } = {}) {
    const view = await this.viewport()
    const scale = 1 / (view.ratio || 1)
    let clip: Rect & { scale: number } = { x: view.x, y: view.y, width: view.width, height: view.height, scale }
    let beyond = false

    if (options.selector) {
      const { rect } = await this.target(options.selector, { glide: false, reach: false })
      // A clip is in document coordinates, so it needs the scroll offset to go
      // with the rect. Measuring may have scrolled the element into view, which
      // moves both, so the offset is read again here: pairing a fresh rect with
      // the offset from before the scroll would capture the wrong strip of page.
      const after = await this.viewport()
      clip = { x: rect.x + after.x, y: rect.y + after.y, width: rect.width, height: rect.height, scale }
      beyond = true
    } else if (options.fullPage) {
      const metrics = await this.connection.send<LayoutMetrics>("Page.getLayoutMetrics")
      const size = metrics.cssContentSize ?? metrics.contentSize
      clip = { x: 0, y: 0, width: size.width, height: size.height, scale }
      beyond = true
    }

    await this.cursor("hide", "1")
    try {
      const result = await this.connection.send<ScreenshotResult>("Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
        clip,
        ...(beyond ? { captureBeyondViewport: true } : {}),
      })
      return Buffer.from(result.data, "base64")
    } finally {
      await this.cursor("hide", "0")
    }
  }

  /** The text on screen, or on the whole page, as a screenshot of it would show. */
  visibleText(options: { fullPage?: boolean; max?: number } = {}) {
    return this.evaluate<string>(`(${VISIBLE_TEXT})(${options.fullPage === true}, ${options.max ?? 6000})`).catch(
      () => "",
    )
  }

  /**
   * A JPEG of what the tab shows, for the trail of the agent's steps.
   *
   * Deliberately no `clip`/`scale`: Chromium shrinks a capture by emulating a
   * smaller device for a moment, and when that capture never completes (a tab
   * hidden behind the app, a debugger dropped mid-capture) the real window stays
   * laid out at the shrunken size, in its top-left corner. The pane scales the
   * picture down itself.
   */
  async thumbnail() {
    const result = await this.connection.send<ScreenshotResult>("Page.captureScreenshot", {
      format: "jpeg",
      quality: 45,
    })
    return Buffer.from(result.data, "base64")
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
   * idle page costs nothing. `size` caps the pictures at what the view shows.
   */
  async startScreencast(onFrame: (frame: Frame) => void, size?: { width: number; height: number }) {
    this.stopCast?.()
    // The picture goes out at once; only the acknowledgement waits, so the view
    // is never behind what happened, and the browser is asked for a new picture
    // at most every CAST_INTERVAL.
    let acked = 0
    let session: unknown
    let timer: ReturnType<typeof setTimeout> | undefined
    // One acknowledgement is owed at a time, for the newest frame seen: a
    // second one would hand the browser another slot and the pace would be back
    // to whatever the page animates at.
    const ack = () => {
      // Frames and command replies share one socket, so the next picture waits
      // while the agent has commands out, up to a point: the view may stutter
      // for a moment, the click must not queue behind pictures of it.
      if ((this.connection.busy ?? 0) > 0 && Date.now() - acked < CAST_INTERVAL + CAST_YIELD) {
        timer = setTimeout(ack, 40)
        return
      }
      acked = Date.now()
      timer = undefined
      void this.connection.send("Page.screencastFrameAck", { sessionId: session }).catch(() => {})
    }
    const off = this.connection.on("Page.screencastFrame", (params) => {
      session = params["sessionId"]
      const metadata = asRecord(params["metadata"])
      onFrame({
        data: asText(params["data"]),
        width: number(metadata["deviceWidth"]),
        height: number(metadata["deviceHeight"]),
      })
      if (timer) return
      const wait = CAST_INTERVAL - (Date.now() - acked)
      if (wait <= 0) ack()
      else timer = setTimeout(ack, wait)
    })
    this.stopCast = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      off()
    }
    this.castRequest = {
      format: "jpeg",
      // Each picture crosses the extension relay and the event stream; this is
      // a live view, not a record, and 50 keeps text legible at a smaller size.
      quality: 50,
      maxWidth: size ? size.width : 1600,
      maxHeight: size ? size.height : 1200,
      everyNthFrame: 1,
    }
    await this.connection.send("Page.startScreencast", this.castRequest)
  }

  async stopScreencast() {
    this.stopCast?.()
    this.stopCast = undefined
    await this.connection.send("Page.stopScreencast").catch(() => {})
  }

  /**
   * Forwards what the person watching does in the live view.
   *
   * Pointer moves and wheel ticks come in many times a second, and the pane
   * sends them one at a time so a mouse-up can never overtake its mouse-down.
   * Waiting for the browser to confirm each one before letting the next leave
   * the pane is what makes dragging and scrolling trail behind the hand, worst of
   * all through the extension, where the confirmation queues behind whatever
   * else is on the socket. So they are chained here instead, kept in order and
   * answered at once; a click or a keystroke, which the pane may follow with
   * something that depends on it, is still waited for.
   */
  async input(event: UserInput) {
    const eager = event.type === "wheel" || (event.type === "mouse" && event.action === "move")
    const sent = this.inputs.catch(() => {}).then(() => this.dispatch(event))
    this.inputs = sent.catch(() => {})
    if (!eager) await sent
  }

  private async dispatch(event: UserInput) {
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
   * Makes sure the page lays out at its own window's size.
   *
   * There is deliberately no counterpart that sets a size. An earlier version
   * laid every page out at the size of the pane watching it, through
   * `Emulation.setDeviceMetricsOverride`, which meant a site reflowed to a
   * narrower layout because someone dragged a panel edge, possibly while the
   * agent was aiming at something. Worse, a page under that override stops
   * reporting title and address changes through `Target.targetInfoChanged`, so
   * the live view quietly fell behind on single page apps. The browser is
   * opened at the configured viewport instead, once, and the pane scales the
   * pictures it receives. This only undoes an override an older version, or a
   * browser we reconnected to, may have left behind.
   */
  async clearResize() {
    await this.connection.send("Emulation.clearDeviceMetricsOverride").catch(() => {})
  }

  /**
   * Fails requests to these hosts before they leave the browser. `hosts` are
   * globs such as `*.doubleclick.net`, which leaves out the bare domain. Newer Chromium takes URL
   * patterns and older only the deprecated wildcard list, so both are tried.
   */
  async block(hosts: readonly string[]) {
    this.blockedHosts = hosts
    await Tab.blockWith((method, params) => this.connection.send(method, params), hosts)
  }

  private static async blockWith(
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
    hosts: readonly string[],
  ) {
    const patterns = hosts.map((host) => `*://${host}/*`)
    await send("Network.setBlockedURLs", { urlPatterns: patterns.map((urlPattern) => ({ urlPattern, block: true })) })
      .catch(() => send("Network.setBlockedURLs", { urls: patterns }))
      .catch(() => {})
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
