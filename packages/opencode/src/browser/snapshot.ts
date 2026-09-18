/**
 * Turns a live page into something a model can act on.
 *
 * Screenshots are expensive and force the model to guess pixel coordinates, so
 * the primary representation is a compact accessibility-style outline where
 * every actionable element carries a stable `ref_N` handle. The page itself is
 * tagged with matching `data-oc-ref` attributes, so acting on a ref is a plain
 * locator lookup rather than coordinate math.
 *
 * Refs are only valid for the snapshot that produced them: navigating or
 * re-snapshotting renumbers everything.
 */

export const REF_ATTRIBUTE = "data-oc-ref"

export interface SnapshotOptions {
  /** Stop after this many emitted nodes so huge pages cannot blow up context. */
  maxNodes?: number
  /** Truncate each accessible name to this many characters. */
  maxNameLength?: number
  /** Include plain text nodes, not just interactive elements and headings. */
  includeText?: boolean
}

export interface SnapshotResult {
  url: string
  title: string
  outline: string
  /** Number of elements that received a ref. */
  refs: number
  /** True when `maxNodes` cut the walk short. */
  truncated: boolean
}

/**
 * Runs inside the page. Written as a source string, and without template
 * literals, so it never depends on DOM typings at build time and survives
 * String.raw unchanged.
 */
export const SCRIPT = String.raw`(options) => {
  var MAX_NODES = options.maxNodes || 1500
  var MAX_NAME = options.maxNameLength || 120
  var INCLUDE_TEXT = options.includeText !== false
  var REF = "data-oc-ref"

  var previous = document.querySelectorAll("[" + REF + "]")
  for (var p = 0; p < previous.length; p++) previous[p].removeAttribute(REF)

  var counter = 0
  var emitted = 0
  var truncated = false
  var lines = []

  var HEADINGS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 }
  var LANDMARKS = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog" }
  var INTERACTIVE_ROLES = {
    button: 1, link: 1, checkbox: 1, radio: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1,
    menuitemradio: 1, switch: 1, textbox: 1, combobox: 1, searchbox: 1, slider: 1,
    spinbutton: 1, option: 1, listbox: 1
  }
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1 }

  function visible(el) {
    if (!el.getClientRects || !el.getClientRects().length) return false
    var style = window.getComputedStyle(el)
    if (!style) return false
    if (style.visibility === "hidden" || style.display === "none") return false
    if (style.opacity === "0") return false
    return true
  }

  function clean(value) {
    if (!value) return ""
    var text = String(value).replace(/\s+/g, " ").trim()
    if (text.length > MAX_NAME) text = text.slice(0, MAX_NAME) + "..."
    return text
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
      var label = document.querySelector("label[for=" + JSON.stringify(escaped) + "]")
      if (label) return label.innerText || label.textContent
    }
    var parent = el.closest ? el.closest("label") : null
    if (parent) return parent.innerText || parent.textContent
    return ""
  }

  function nameOf(el, role) {
    var aria = el.getAttribute("aria-label")
    if (aria) return clean(aria)

    var labelledby = el.getAttribute("aria-labelledby")
    if (labelledby) {
      var parts = []
      var ids = labelledby.split(/\s+/)
      for (var i = 0; i < ids.length; i++) {
        var target = document.getElementById(ids[i])
        if (target) parts.push(target.innerText || target.textContent || "")
      }
      if (parts.length) return clean(parts.join(" "))
    }

    if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton") {
      var explicit = clean(labelFor(el))
      if (explicit) return explicit
      var placeholder = el.getAttribute("placeholder")
      if (placeholder) return clean(placeholder)
      var named = el.getAttribute("name")
      if (named) return clean(named)
      return ""
    }

    if (el.tagName === "IMG") return clean(el.getAttribute("alt") || "")
    if (el.tagName === "INPUT") {
      var value = el.getAttribute("value")
      if (value) return clean(value)
      return clean(labelFor(el) || el.getAttribute("name") || "")
    }

    var title = el.getAttribute("title")
    var text = clean(el.innerText || el.textContent || "")
    if (!text && title) return clean(title)
    return text
  }

  function ownText(el) {
    var text = ""
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i]
      if (node.nodeType === 3) text += node.nodeValue
    }
    return clean(text)
  }

  function describe(el, role) {
    var bits = []
    if (role === "heading") {
      var level = HEADINGS[el.tagName] || el.getAttribute("aria-level")
      if (level) bits.push("level=" + level)
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled")
    var checked = el.getAttribute("aria-checked")
    if (checked) bits.push("checked=" + checked)
    else if (typeof el.checked === "boolean" && (role === "checkbox" || role === "radio"))
      bits.push("checked=" + el.checked)
    var expanded = el.getAttribute("aria-expanded")
    if (expanded) bits.push("expanded=" + expanded)
    var selected = el.getAttribute("aria-selected")
    if (selected) bits.push("selected=" + selected)
    if (role === "link") {
      var href = el.getAttribute("href")
      if (href && href.indexOf("javascript:") !== 0) bits.push("href=" + clean(href))
    }
    if ((role === "textbox" || role === "searchbox") && el.value) bits.push("value=" + clean(el.value))
    return bits
  }

  function actionable(el, role) {
    if (role === "hidden") return false
    if (INTERACTIVE_ROLES[role]) return true
    if (el.tagName === "A" && el.hasAttribute("href")) return true
    if (el.hasAttribute("onclick")) return true
    if (el.isContentEditable) return true
    if (el.getAttribute("tabindex") !== null && el.getAttribute("tabindex") !== "-1") return true
    return false
  }

  function emit(depth, text) {
    if (emitted >= MAX_NODES) {
      truncated = true
      return false
    }
    var pad = ""
    for (var i = 0; i < depth; i++) pad += "  "
    lines.push(pad + "- " + text)
    emitted++
    return true
  }

  function walk(el, depth) {
    if (emitted >= MAX_NODES) {
      truncated = true
      return
    }
    if (!el || el.nodeType !== 1) return
    if (SKIP[el.tagName]) return
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return
    if (!visible(el)) return

    var role = roleOf(el)
    if (role === "hidden") return

    var childDepth = depth
    var act = actionable(el, role)
    var interesting = act || role === "heading" || LANDMARKS[el.tagName] || role === "img" || role === "iframe"

    if (interesting) {
      var name = nameOf(el, role)
      var parts = [role]
      if (name) parts.push(JSON.stringify(name))
      var extra = describe(el, role)
      if (act) {
        counter++
        el.setAttribute(REF, "ref_" + counter)
        extra.unshift("ref_" + counter)
      }
      if (extra.length) parts.push("[" + extra.join(" ") + "]")
      if (!emit(depth, parts.join(" "))) return
      childDepth = depth + 1
    } else if (INCLUDE_TEXT) {
      var text = ownText(el)
      if (text && text.length > 1) {
        if (!emit(depth, "text: " + text)) return
        childDepth = depth + 1
      }
    }

    // Inputs and buttons describe themselves; their children add only noise.
    if (role === "textbox" || role === "searchbox" || role === "button" || role === "img") return

    for (var c = 0; c < el.children.length; c++) walk(el.children[c], childDepth)
  }

  walk(document.body, 0)

  return {
    url: document.location.href,
    title: document.title || "",
    outline: lines.join("\n"),
    refs: counter,
    truncated: truncated
  }
}`

/** Plain visible text of the page, for when the outline is not what is wanted. */
export const TEXT_SCRIPT = String.raw`() => {
  var body = document.body
  return {
    url: document.location.href,
    title: document.title || "",
    text: body ? (body.innerText || body.textContent || "") : ""
  }
}`

/** Full serialized DOM, used as the source for markdown conversion. */
export const HTML_SCRIPT = String.raw`() => {
  return {
    url: document.location.href,
    title: document.title || "",
    html: document.documentElement ? document.documentElement.outerHTML : ""
  }
}`

/** CSS selector that finds the element a snapshot ref points at. */
export function locator(ref: string) {
  const normalized = ref.startsWith("ref_") ? ref : `ref_${ref}`
  return `[${REF_ATTRIBUTE}="${normalized}"]`
}

export * as BrowserSnapshot from "./snapshot"
