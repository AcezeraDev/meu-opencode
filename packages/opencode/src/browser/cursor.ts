/**
 * A visible stand-in for the agent's pointer, drawn inside the page.
 *
 * CDP input events move no cursor that anyone can see, so while someone is
 * watching the browser, this overlay shows where the agent is about to act:
 * it glides to the target, outlines it, and ripples on the click. A soft glow
 * around the viewport says the agent is in control, the way Claude's browser
 * does; both fade out once the agent goes quiet, so a person using the same
 * page is not left with a stray arrow. It lives in a closed shadow root
 * attached to <html> rather than <body>, so the snapshot never walks into it,
 * and it ignores the pointer entirely.
 *
 * Everything animates through `transform` and `opacity` only, which the
 * compositor handles without laying the page out again: the overlay has to be
 * cheap enough to be invisible in the page's own frame budget, since it is
 * drawn over the person's real browsing.
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
  /** Quick enough to keep up with the agent, slow enough to follow by eye. */
  var GLIDE_MIN = 70
  var GLIDE_MAX = 190
  var GLIDE_PER_PIXEL = 0.16
  /**
   * How much of a glide the agent waits out before pressing. The last stretch
   * of an ease-out is the cursor easing into place over a couple of pixels, so
   * the press lands while it visually arrives instead of after it has settled.
   */
  var GLIDE_WAIT = 0.72
  /** How long after the agent's last move the cursor and glow fade away. */
  var IDLE = 2000
  /** An ease-out that leaves fast and arrives gently, so motion reads as one movement. */
  var EASE = "cubic-bezier(0.22, 1, 0.36, 1)"
  /** How far behind the arrow the trail runs, as a share of the glide. */
  var TRAIL_LAG = 0.18
  var state = {
    host: null,
    pointer: null,
    trail: null,
    ripple: null,
    halo: null,
    box: null,
    glow: null,
    x: startX,
    y: startY,
    timer: 0,
  }

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

    var glow = document.createElement("div")
    glow.style.cssText =
      "position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;opacity:0;will-change:opacity;" +
      "transition:opacity 260ms ease;" +
      "box-shadow:inset 0 0 0 1px rgba(63, 208, 224, 0.45), inset 0 0 22px 2px rgba(63, 208, 224, 0.16);"

    var box = document.createElement("div")
    box.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;box-sizing:border-box;pointer-events:none;" +
      "border:1.5px solid " + TRACE + ";border-radius:8px;opacity:0;will-change:transform,opacity;" +
      "box-shadow:0 0 0 4px rgba(63, 208, 224, 0.10);"

    /** The soft wash under a press, which reads as the click's weight. */
    var halo = document.createElement("div")
    halo.style.cssText =
      "position:fixed;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;pointer-events:none;" +
      "border-radius:50%;opacity:0;will-change:transform,opacity;" +
      "background:radial-gradient(circle, rgba(63, 208, 224, 0.30) 0%, rgba(63, 208, 224, 0) 70%);"

    var ripple = document.createElement("div")
    ripple.style.cssText =
      "position:fixed;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;box-sizing:border-box;" +
      "pointer-events:none;border:1.5px solid " + TRACE + ";border-radius:50%;opacity:0;" +
      "will-change:transform,opacity;"

    /** A dot running a little behind the arrow, so a move reads as a movement. */
    var trail = document.createElement("div")
    trail.style.cssText =
      "position:fixed;left:0;top:0;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;pointer-events:none;" +
      "border-radius:50%;background:rgba(63, 208, 224, 0.55);opacity:0;will-change:transform,opacity;" +
      "transition:opacity 200ms ease;" +
      "transform:translate(" + state.x + "px," + state.y + "px);"

    var pointer = document.createElement("div")
    pointer.style.cssText =
      "position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;will-change:transform,opacity;" +
      "opacity:0;transition:opacity 180ms ease;" +
      "filter:drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35)) drop-shadow(0 0 4px rgba(63, 208, 224, 0.45));" +
      "transform:translate(" + (state.x - 3) + "px," + (state.y - 2) + "px);"

    var svg = document.createElementNS(NS, "svg")
    svg.setAttribute("width", "22")
    svg.setAttribute("height", "22")
    svg.setAttribute("viewBox", "0 0 24 24")
    var arrow = document.createElementNS(NS, "path")
    arrow.setAttribute("d", "M3 2 L3 19.5 L7.6 15 L10.6 21.8 L13.5 20.5 L10.5 13.8 L17 13.8 Z")
    arrow.setAttribute("fill", "#0b0f12")
    arrow.setAttribute("stroke", "#ffffff")
    arrow.setAttribute("stroke-width", "1.5")
    arrow.setAttribute("stroke-linejoin", "round")
    svg.appendChild(arrow)
    pointer.appendChild(svg)

    root.appendChild(glow)
    root.appendChild(box)
    root.appendChild(halo)
    root.appendChild(ripple)
    root.appendChild(trail)
    root.appendChild(pointer)
    doc.appendChild(host)

    state.host = host
    state.pointer = pointer
    state.trail = trail
    state.ripple = ripple
    state.halo = halo
    state.box = box
    state.glow = glow
    return true
  }

  /** Shows the cursor and the glow, and schedules both to fade once the agent is idle. */
  function wake() {
    state.pointer.style.opacity = "1"
    state.trail.style.opacity = "1"
    state.glow.style.opacity = "1"
    clearTimeout(state.timer)
    state.timer = setTimeout(function () {
      if (!state.pointer) return
      state.pointer.style.opacity = "0"
      state.trail.style.opacity = "0"
      state.glow.style.opacity = "0"
    }, IDLE)
  }

  /**
   * Keeps the drawn arrow on screen. Only the drawing is clamped: the click
   * itself is dispatched at the real coordinates, which is what matters, and a
   * cursor drawn past the edge would simply be invisible.
   */
  function onScreen(value, max) {
    if (!(value > 0)) return 0
    return value > max - 1 ? max - 1 : value
  }

  function at(x, y) {
    return "translate(" + (x - 3) + "px," + (y - 2) + "px)"
  }

  function dot(x, y) {
    return "translate(" + x + "px," + y + "px)"
  }

  function place(x, y) {
    state.x = onScreen(x, innerWidth)
    state.y = onScreen(y, innerHeight)
    if (!build()) return
    state.pointer.style.transform = at(state.x, state.y)
    state.trail.style.transform = dot(state.x, state.y)
    wake()
  }

  function move(x, y, duration) {
    if (!build()) return
    var fromX = state.x
    var fromY = state.y
    state.x = onScreen(x, innerWidth)
    state.y = onScreen(y, innerHeight)
    state.pointer.style.transform = at(state.x, state.y)
    state.trail.style.transform = dot(state.x, state.y)
    if (duration > 0 && state.pointer.animate) {
      state.pointer.animate([{ transform: at(fromX, fromY) }, { transform: at(state.x, state.y) }], {
        duration: duration,
        easing: EASE,
      })
      // The trail leaves with the arrow and arrives after it, which is what
      // makes the move read as one gesture rather than a jump.
      state.trail.animate([{ transform: dot(fromX, fromY) }, { transform: dot(state.x, state.y) }], {
        duration: duration + Math.round(duration * TRAIL_LAG),
        easing: EASE,
      })
    }
    wake()
  }

  function highlight(x, y, width, height, duration) {
    if (!build()) return
    var box = state.box
    box.style.left = x - 4 + "px"
    box.style.top = y - 4 + "px"
    box.style.width = width + 8 + "px"
    box.style.height = height + 8 + "px"
    if (box.animate) {
      box.animate(
        [
          { opacity: 0, transform: "scale(1.04)" },
          { opacity: 1, transform: "scale(1)", offset: 0.25 },
          { opacity: 1, transform: "scale(1)", offset: 0.7 },
          { opacity: 0, transform: "scale(1)" }
        ],
        { duration: duration || 700, easing: "ease-out" }
      )
    }
  }

  /**
   * Outlines a target and glides onto the point the click will land on, which
   * is its middle unless something covers that. Returns how long the caller
   * should wait before pressing: a little less than the glide, since the tail
   * of the ease is the arrow settling the last pixel or two into place.
   */
  function glide(px, py, x, y, width, height) {
    if (!build()) return 0
    var dx = px - state.x
    var dy = py - state.y
    var distance = Math.sqrt(dx * dx + dy * dy)
    var duration = Math.round(Math.min(GLIDE_MAX, GLIDE_MIN + distance * GLIDE_PER_PIXEL))
    highlight(x, y, width, height, duration + 500)
    move(px, py, duration)
    return Math.round(duration * GLIDE_WAIT)
  }

  function click() {
    if (!build()) return
    var ripple = state.ripple
    var halo = state.halo
    ripple.style.left = state.x + "px"
    ripple.style.top = state.y + "px"
    halo.style.left = state.x + "px"
    halo.style.top = state.y + "px"
    if (ripple.animate) {
      ripple.animate(
        [
          { transform: "scale(0.25)", opacity: 0.9 },
          { transform: "scale(1.5)", opacity: 0 }
        ],
        { duration: 420, easing: EASE }
      )
      halo.animate(
        [
          { transform: "scale(0.4)", opacity: 0.85 },
          { transform: "scale(1.15)", opacity: 0 }
        ],
        { duration: 300, easing: "ease-out" }
      )
    }
    if (state.pointer.animate) {
      state.pointer.animate(
        [{ scale: "1" }, { scale: "0.82" }, { scale: "1.04" }, { scale: "1" }],
        { duration: 220, easing: "ease-out" }
      )
    }
    wake()
  }

  /** Lights the glow without moving, for actions that have no target, like typing or scrolling. */
  function busy() {
    if (!build()) return
    wake()
  }

  function hide(hidden) {
    if (state.host) state.host.style.display = hidden ? "none" : "block"
  }

  var api = { place: place, move: move, glide: glide, click: click, highlight: highlight, busy: busy, hide: hide }
  // Not enumerable, so it does not show up for pages that walk window.
  Object.defineProperty(window, KEY, { value: api, configurable: true, enumerable: false })
  return api
})`

/** The tag of the overlay's host element, stripped from serialized HTML. */
export const HOST_TAG = "oc-agent-cursor"

export * as BrowserCursor from "./cursor"
