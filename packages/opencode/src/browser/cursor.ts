/**
 * A visible stand-in for the agent's pointer, drawn inside the page.
 *
 * CDP input events move no cursor that anyone can see, so while someone is
 * watching the browser, this overlay shows where the agent is about to act:
 * it glides to the target, outlines it, and ripples on the click. It lives in a
 * closed shadow root attached to <html> rather than <body>, so the snapshot
 * never walks into it, and it ignores the pointer entirely.
 *
 * Everything is built with DOM calls and styled through the CSSOM, never with
 * innerHTML or <style> elements, because pages with a strict Content Security
 * Policy or Trusted Types would reject those and the overlay would silently
 * vanish exactly on the sites where it is most useful. Written without template
 * literals so it survives String.raw unchanged.
 *
 * The source evaluates to a function taking the position to start from, and
 * returns the page's cursor controller, installing it on first use.
 */
export const SCRIPT = String.raw`(function (startX, startY) {
  var KEY = "__ocAgentCursor"
  var existing = window[KEY]
  if (existing) return existing

  var TRACE = "rgb(63, 208, 224)"
  var NS = "http://www.w3.org/2000/svg"
  var state = { host: null, pointer: null, ripple: null, box: null, x: startX, y: startY }

  function build() {
    if (state.host && state.host.isConnected) return true
    var doc = document.documentElement
    if (!doc) return false

    var host = document.createElement("oc-agent-cursor")
    host.setAttribute("aria-hidden", "true")
    host.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;" +
      "z-index:2147483647;display:block;margin:0;padding:0;border:0;"
    var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host

    var box = document.createElement("div")
    box.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;box-sizing:border-box;pointer-events:none;" +
      "border:2px solid " + TRACE + ";border-radius:6px;opacity:0;" +
      "box-shadow:0 0 0 3px rgba(63, 208, 224, 0.16);"

    var ripple = document.createElement("div")
    ripple.style.cssText =
      "position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;box-sizing:border-box;" +
      "pointer-events:none;border:2px solid " + TRACE + ";border-radius:50%;opacity:0;"

    var pointer = document.createElement("div")
    pointer.style.cssText =
      "position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;will-change:transform;" +
      "filter:drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5)) drop-shadow(0 0 5px rgba(63, 208, 224, 0.6));" +
      "transform:translate(" + (state.x - 3) + "px," + (state.y - 2) + "px);"

    var svg = document.createElementNS(NS, "svg")
    svg.setAttribute("width", "24")
    svg.setAttribute("height", "24")
    svg.setAttribute("viewBox", "0 0 24 24")
    var arrow = document.createElementNS(NS, "path")
    arrow.setAttribute("d", "M3 2 L3 19.5 L7.6 15 L10.6 21.8 L13.5 20.5 L10.5 13.8 L17 13.8 Z")
    arrow.setAttribute("fill", "#0b0f12")
    arrow.setAttribute("stroke", "#ffffff")
    arrow.setAttribute("stroke-width", "1.6")
    arrow.setAttribute("stroke-linejoin", "round")
    svg.appendChild(arrow)
    pointer.appendChild(svg)

    root.appendChild(box)
    root.appendChild(ripple)
    root.appendChild(pointer)
    doc.appendChild(host)

    state.host = host
    state.pointer = pointer
    state.ripple = ripple
    state.box = box
    return true
  }

  function place(x, y) {
    state.x = x
    state.y = y
    if (!build()) return
    state.pointer.style.transform = "translate(" + (x - 3) + "px," + (y - 2) + "px)"
  }

  function move(x, y, duration) {
    if (!build()) return
    var from = "translate(" + (state.x - 3) + "px," + (state.y - 2) + "px)"
    var to = "translate(" + (x - 3) + "px," + (y - 2) + "px)"
    state.x = x
    state.y = y
    state.pointer.style.transform = to
    if (duration > 0 && state.pointer.animate) {
      state.pointer.animate([{ transform: from }, { transform: to }], {
        duration: duration,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)"
      })
    }
  }

  function click() {
    if (!build()) return
    var ripple = state.ripple
    ripple.style.left = state.x + "px"
    ripple.style.top = state.y + "px"
    if (ripple.animate) {
      ripple.animate(
        [
          { transform: "scale(0.3)", opacity: 0.95 },
          { transform: "scale(1.45)", opacity: 0 }
        ],
        { duration: 520, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
      )
    }
    if (state.pointer.animate) {
      state.pointer.animate([{ scale: "1" }, { scale: "0.84" }, { scale: "1" }], { duration: 220, easing: "ease-out" })
    }
  }

  function highlight(x, y, width, height) {
    if (!build()) return
    var box = state.box
    box.style.left = x - 4 + "px"
    box.style.top = y - 4 + "px"
    box.style.width = width + 8 + "px"
    box.style.height = height + 8 + "px"
    if (box.animate) {
      box.animate(
        [
          { opacity: 0 },
          { opacity: 1, offset: 0.18 },
          { opacity: 1, offset: 0.72 },
          { opacity: 0 }
        ],
        { duration: 1200, easing: "ease-out" }
      )
    }
  }

  function hide(hidden) {
    if (state.host) state.host.style.display = hidden ? "none" : "block"
  }

  var api = { place: place, move: move, click: click, highlight: highlight, hide: hide }
  // Not enumerable, so it does not show up for pages that walk window.
  Object.defineProperty(window, KEY, { value: api, configurable: true, enumerable: false })
  return api
})`

/** The tag of the overlay's host element, stripped from serialized HTML. */
export const HOST_TAG = "oc-agent-cursor"

export * as BrowserCursor from "./cursor"
