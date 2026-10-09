/**
 * A visible stand-in for the agent's pointer, drawn inside the page.
 *
 * CDP input events move no cursor that anyone can see, so while someone is
 * watching the browser, this overlay shows where the agent is about to act:
 * it glides to the target, outlines it, and ripples on the click. A soft glow
 * around the viewport says the agent is in control, the way Claude's browser
 * does. The glow fades once the agent goes quiet, but the arrow stays where it
 * last acted, floating gently, so the person never loses track of it. Each
 * kind of action can also make a short sound (a click, keys, a wheel, a
 * shutter), synthesized with Web Audio so there is nothing to fetch and no
 * policy of the page to trip over; the person turns them on or off with
 * `browser.sounds`. What the agent is doing ("Clicando em Entrar", "Lendo a
 * página", the writer composing a text) is said either on the tag beside the
 * arrow or on a small card in the corner of the page, as `browser.thoughts`
 * picks, or not at all. It lives in a closed shadow root
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
 * The source evaluates to a function taking the position to start from, the
 * project's color, whether sounds are on and where thoughts are shown, and returns the page's cursor
 * controller, installing it on first use.
 */
export const SCRIPT = String.raw`(function (startX, startY, accent, sound, thoughts) {
  var KEY = "__ocAgentCursor"
  var existing = window[KEY]
  if (existing) {
    // A page keeps its overlay across calls; the color or the settings may have changed since.
    if (existing.configure) existing.configure(accent, sound, thoughts)
    else if (existing.tint) existing.tint(accent)
    return existing
  }

  /** The project's space as "r, g, b", so every part mixes its own alpha of it. */
  var rgb = accent || "255, 107, 91"
  function tone(alpha) {
    return "rgba(" + rgb + ", " + alpha + ")"
  }
  var NS = "http://www.w3.org/2000/svg"
  /**
   * How long a person takes to reach a target, after Fitts's law: a fixed
   * start plus a share that grows with how far the target is and how small.
   * Clamped so a short hop is still seen and a long reach never drags.
   */
  var REACH_START = 150
  var REACH_PER_BIT = 95
  var REACH_MIN = 140
  var REACH_MAX = 560
  /** Moves shorter than this go straight: a hand makes no arc over a few pixels. */
  var STRAIGHT = 40
  /** Moves longer than this overshoot a little and come back, as a hand does. */
  var OVERSHOOT = 180
  /**
   * How much of a reach the agent waits out before pressing: nearly all of it,
   * so the press lands as the arrow settles, plus the beat a person takes
   * between arriving and clicking.
   */
  var PRESS_AT = 0.94
  var PRESS_BEAT = 50
  /** How long after the agent's last move the glow fades and the arrow starts to float. */
  var IDLE = 2000
  /** How far the arrow leans into a move, at most, in degrees. */
  var LEAN = 14
  /** How loud the sounds are, from 0 to 1: present but never louder than the page. */
  var VOLUME = 0.55
  /** An ease-out that leaves fast and arrives gently, so motion reads as one movement. */
  var EASE = "cubic-bezier(0.22, 1, 0.36, 1)"
  /** How far behind the arrow the trail runs, as a share of the glide. */
  var TRAIL_LAG = 0.18
  /** How long a thought stays up after the agent's last word, unless it is still under way. */
  var LINGER = 3500
  /** How many earlier thoughts the card keeps under the current one. */
  var PAST = 2
  /** Where thoughts show: "cursor" on the tag, "card" in the corner, "off" nowhere. */
  var where = thoughts || "cursor"
  var state = {
    host: null,
    pointer: null,
    trail: null,
    ripple: null,
    halo: null,
    box: null,
    glow: null,
    tag: null,
    label: null,
    body: null,
    flash: null,
    wheel: null,
    notch: null,
    rail: null,
    thumb: null,
    railing: 0,
    float: null,
    motion: null,
    drift: null,
    card: null,
    now: null,
    detail: null,
    status: null,
    pulse: null,
    beat: null,
    past: null,
    said: [],
    x: startX,
    y: startY,
    timer: 0,
    quiet: 0,
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
      "transition:opacity 260ms ease;"

    /** The spotlight: the rest of the page dims for a moment around what the agent is about to touch. */
    var spot = document.createElement("div")
    spot.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;border-radius:10px;opacity:0;" +
      "box-shadow:0 0 0 200vmax rgba(0, 0, 0, 0.34);will-change:opacity;"

    var box = document.createElement("div")
    box.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;box-sizing:border-box;pointer-events:none;" +
      "border:1.5px solid;border-radius:8px;opacity:0;will-change:transform,opacity;"

    /** The name of what the agent is about to act on, on a tab above the outline. */
    var label = document.createElement("div")
    label.style.cssText =
      "position:absolute;left:-1.5px;bottom:calc(100% + 3px);max-width:240px;padding:2px 6px;" +
      "border-radius:5px 5px 5px 0;font:600 10.5px/1.35 system-ui,-apple-system,'Segoe UI',sans-serif;" +
      "color:#0b0b10;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;"
    box.appendChild(label)

    /** The soft wash under a press, which reads as the click's weight. */
    var halo = document.createElement("div")
    halo.style.cssText =
      "position:fixed;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;pointer-events:none;" +
      "border-radius:50%;opacity:0;will-change:transform,opacity;"

    var ripple = document.createElement("div")
    ripple.style.cssText =
      "position:fixed;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;box-sizing:border-box;" +
      "pointer-events:none;border:1.5px solid;border-radius:50%;opacity:0;" +
      "will-change:transform,opacity;"

    /** A dot running a little behind the arrow, so a move reads as a movement. */
    var trail = document.createElement("div")
    trail.style.cssText =
      "position:fixed;left:0;top:0;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;pointer-events:none;" +
      "border-radius:50%;opacity:0;will-change:transform,opacity;" +
      "transition:opacity 200ms ease;" +
      "transform:translate(" + state.x + "px," + state.y + "px);"

    var pointer = document.createElement("div")
    pointer.style.cssText =
      "position:fixed;left:0;top:0;width:40px;height:40px;pointer-events:none;will-change:transform,opacity;" +
      "opacity:0;transition:opacity 180ms ease;" +
      "transform:translate(" + (state.x - 3) + "px," + (state.y - 2) + "px);"

    /** Leans, presses and floats on its own, while the pointer around it only travels. */
    var body = document.createElement("div")
    body.style.cssText =
      "position:absolute;left:0;top:0;width:40px;height:40px;transform-origin:3px 2px;will-change:transform;"
    pointer.appendChild(body)

    var svg = document.createElementNS(NS, "svg")
    svg.setAttribute("width", "40")
    svg.setAttribute("height", "40")
    // A rounded arrowhead with a soft notch underneath. The viewBox is shifted so
    // its tip lands at (3, 2) px, the hot spot every translate below assumes.
    svg.setAttribute("viewBox", "2.1 1.1 24 24")
    var arrow = document.createElementNS(NS, "path")
    arrow.setAttribute(
      "d",
      "M3.1 4.7 L3.67 17.4 Q3.86 20.2 6.33 18.7 L9 15.45 Q10.33 13.74 12.7 13.74 L15.67 13.74 Q19.86 12.8 16.5 10.2 L6.7 2.3 Q3.1 -0.07 3.1 4.7 Z",
    )
    arrow.setAttribute("fill", "#0b0f12")
    arrow.setAttribute("stroke", "#ffffff")
    arrow.setAttribute("stroke-width", "1.1")
    arrow.setAttribute("stroke-linejoin", "round")
    svg.appendChild(arrow)
    body.appendChild(svg)

    /** Says whose pointer this is, so it is never mistaken for the person's own. */
    var tag = document.createElement("div")
    tag.textContent = "IA"
    tag.style.cssText =
      "position:absolute;left:28px;top:31px;padding:1px 5px;border-radius:99px;max-width:230px;" +
      "font:700 9px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:0.04em;color:#0b0b10;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
    body.appendChild(tag)

    /**
     * The agent's thoughts in the corner: what it is doing now, in bold, with
     * what it did just before fading under it, and for work off the page (the
     * writer composing a text) what was asked and how far it has got.
     */
    var card = document.createElement("div")
    card.style.cssText =
      "position:fixed;right:16px;bottom:16px;width:300px;max-width:calc(100vw - 32px);box-sizing:border-box;" +
      "padding:10px 12px;border-radius:10px;background:rgba(14, 16, 20, 0.94);color:#e8eaed;" +
      "font:12px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 8px 28px rgba(0, 0, 0, 0.35);" +
      "display:none;opacity:0;transform:translateY(8px);transition:opacity 220ms ease,transform 220ms ease;" +
      "will-change:transform,opacity;pointer-events:none;"
    var head = document.createElement("div")
    head.style.cssText = "display:flex;align-items:center;gap:7px;"
    var pulse = document.createElement("div")
    pulse.style.cssText = "flex:none;width:7px;height:7px;border-radius:50%;"
    var now = document.createElement("div")
    now.style.cssText =
      "flex:1;min-width:0;font-weight:650;color:#ffffff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
    head.appendChild(pulse)
    head.appendChild(now)
    var detail = document.createElement("div")
    detail.style.cssText =
      "margin-top:5px;color:#b9bdc4;white-space:pre-wrap;overflow:hidden;display:none;" +
      "-webkit-line-clamp:4;-webkit-box-orient:vertical;"
    var status = document.createElement("div")
    status.style.cssText = "margin-top:6px;font-weight:600;display:none;"
    var past = document.createElement("div")
    past.style.cssText = "margin-top:4px;color:#8b9097;font-size:11px;"
    card.appendChild(head)
    card.appendChild(detail)
    card.appendChild(status)
    card.appendChild(past)

    /** The page lighting up for a moment, when the agent takes a picture of it. */
    var flash = document.createElement("div")
    flash.style.cssText =
      "position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;opacity:0;background:#ffffff;" +
      "will-change:opacity;"

    /** A small mouse wheel by the arrow, whose notch runs the way the page scrolls. */
    var wheel = document.createElement("div")
    wheel.style.cssText =
      "position:fixed;left:0;top:0;width:13px;height:20px;box-sizing:border-box;pointer-events:none;" +
      "border:1.5px solid;border-radius:7px;opacity:0;background:rgba(11, 15, 18, 0.55);" +
      "will-change:transform,opacity;"
    var notch = document.createElement("div")
    notch.style.cssText =
      "position:absolute;left:50%;top:50%;width:3px;height:5px;margin:-2.5px 0 0 -1.5px;border-radius:2px;"
    wheel.appendChild(notch)

    /** A thin rail on the right edge whose thumb glides as the agent scrolls the page. */
    var rail = document.createElement("div")
    rail.style.cssText =
      "position:fixed;right:5px;top:12%;height:76%;width:4px;border-radius:2px;pointer-events:none;opacity:0;" +
      "background:rgba(255, 255, 255, 0.14);box-shadow:0 0 0 1px rgba(0, 0, 0, 0.18);transition:opacity 0.25s ease;"
    var thumb = document.createElement("div")
    thumb.style.cssText = "position:absolute;left:0;width:4px;height:18%;top:0;border-radius:2px;will-change:top;"
    rail.appendChild(thumb)

    root.appendChild(glow)
    root.appendChild(spot)
    root.appendChild(box)
    root.appendChild(halo)
    root.appendChild(ripple)
    root.appendChild(trail)
    root.appendChild(wheel)
    root.appendChild(rail)
    root.appendChild(pointer)
    root.appendChild(flash)
    root.appendChild(card)
    doc.appendChild(host)

    state.host = host
    state.root = root
    state.pointer = pointer
    state.trail = trail
    state.ripple = ripple
    state.halo = halo
    state.box = box
    state.spot = spot
    state.glow = glow
    state.tag = tag
    state.label = label
    state.body = body
    state.flash = flash
    state.wheel = wheel
    state.notch = notch
    state.rail = rail
    state.thumb = thumb
    state.card = card
    state.now = now
    state.detail = detail
    state.status = status
    state.pulse = pulse
    state.past = past
    state.said = []
    paint()
    return true
  }

  /** Colors every part in the current tone. */
  function paint() {
    state.glow.style.boxShadow = "inset 0 0 0 1px " + tone(0.45) + ", inset 0 0 22px 2px " + tone(0.16)
    state.box.style.borderColor = "rgb(" + rgb + ")"
    state.box.style.boxShadow = "0 0 0 4px " + tone(0.1)
    state.label.style.background = "rgb(" + rgb + ")"
    state.halo.style.background = "radial-gradient(circle, " + tone(0.3) + " 0%, " + tone(0) + " 70%)"
    state.ripple.style.borderColor = "rgb(" + rgb + ")"
    state.trail.style.background = tone(0.55)
    state.pointer.style.filter = "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35)) drop-shadow(0 0 4px " + tone(0.45) + ")"
    state.tag.style.background = "rgb(" + rgb + ")"
    state.wheel.style.borderColor = "rgb(" + rgb + ")"
    state.notch.style.background = "rgb(" + rgb + ")"
    state.thumb.style.background = "rgb(" + rgb + ")"
    state.thumb.style.boxShadow = "0 0 8px " + tone(0.7)
    state.card.style.borderLeft = "3px solid rgb(" + rgb + ")"
    state.pulse.style.background = "rgb(" + rgb + ")"
    state.status.style.color = "rgb(" + rgb + ")"
  }

  function tint(next) {
    if (!next || next === rgb) return
    rgb = next
    if (state.host) paint()
  }

  function configure(next, on, show) {
    tint(next)
    sound = !!on
    if (!show || show === where) return
    where = show
    if (state.host) quiet()
  }

  /**
   * Shows the cursor and the glow. Once the agent is idle the glow and the
   * trail fade, but the arrow stays where it last acted and floats a little,
   * so it can always be found and never looks frozen.
   */
  function wake() {
    state.pointer.style.opacity = "1"
    state.trail.style.opacity = "1"
    state.glow.style.opacity = "1"
    if (state.float) {
      // Settle from wherever the float had got to, instead of snapping back.
      var lift = getComputedStyle(state.body).translate
      state.float.cancel()
      state.float = null
      if (lift && lift !== "none" && state.body.animate) {
        state.body.animate([{ translate: lift }, { translate: "0 0" }], { duration: 140, easing: "ease-out" })
      }
    }
    clearTimeout(state.timer)
    state.timer = setTimeout(function () {
      if (!state.pointer) return
      state.trail.style.opacity = "0"
      state.glow.style.opacity = "0"
      if (state.body.animate) {
        state.float = state.body.animate([{ translate: "0 0" }, { translate: "0 -2.5px" }], {
          duration: 1500,
          iterations: Infinity,
          direction: "alternate",
          easing: "ease-in-out",
        })
      }
    }, IDLE)
  }

  /** Sounds, made on the spot: no files to fetch, nothing a page's policy can block. */
  var audio = null
  var out = null
  var hiss = null

  function context() {
    if (!sound) return null
    try {
      if (!audio) {
        var Context = window.AudioContext || window.webkitAudioContext
        if (!Context) return null
        audio = new Context()
        out = audio.createGain()
        out.gain.value = VOLUME
        out.connect(audio.destination)
      }
      // The agent's commands count as a gesture, which is what lets a page start audio.
      if (audio.state === "suspended") audio.resume()
      return audio
    } catch (error) {
      return null
    }
  }

  function noise(a) {
    if (hiss) return hiss
    var length = Math.round(a.sampleRate * 0.3)
    hiss = a.createBuffer(1, length, a.sampleRate)
    var data = hiss.getChannelData(0)
    for (var i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
    return hiss
  }

  /** A burst of filtered noise, the body of every click and tick. */
  function burst(a, at, length, type, frequency, q, gain) {
    var source = a.createBufferSource()
    source.buffer = noise(a)
    var filter = a.createBiquadFilter()
    filter.type = type
    filter.frequency.value = frequency
    filter.Q.value = q
    var level = a.createGain()
    level.gain.setValueAtTime(gain, at)
    level.gain.exponentialRampToValueAtTime(0.0001, at + length)
    source.connect(filter)
    filter.connect(level)
    level.connect(out)
    source.start(at, Math.random() * 0.15)
    source.stop(at + length + 0.02)
  }

  /** A short tone gliding from one pitch to another. */
  function beep(a, at, from, to, length, gain) {
    var osc = a.createOscillator()
    osc.type = "sine"
    osc.frequency.setValueAtTime(from, at)
    osc.frequency.exponentialRampToValueAtTime(to, at + length)
    var level = a.createGain()
    level.gain.setValueAtTime(0.0001, at)
    level.gain.exponentialRampToValueAtTime(gain, at + 0.008)
    level.gain.exponentialRampToValueAtTime(0.0001, at + length)
    osc.connect(level)
    level.connect(out)
    osc.start(at)
    osc.stop(at + length + 0.02)
  }

  var SOUNDS = {
    // A mouse button: the sharp press with a little weight under it, then the softer release.
    click: function (a, t) {
      burst(a, t, 0.03, "bandpass", 2600, 1.1, 0.5)
      beep(a, t, 170, 60, 0.06, 0.3)
      burst(a, t + 0.075, 0.02, "bandpass", 3400, 1.4, 0.2)
    },
    // One key, never quite the same twice.
    key: function (a, t) {
      burst(a, t, 0.022, "bandpass", 1700 + Math.random() * 1500, 1.6, 0.14 + Math.random() * 0.08)
    },
    // A soft wheel rolling: quiet notches that speed up and slow down with the
    // page, over a faint brush of air, small enough to sit under anything.
    scroll: function (a, t) {
      burst(a, t, 0.42, "lowpass", 900, 0.6, 0.035)
      var at = 0
      for (var i = 0; i < 9; i++) {
        var gap = 0.03 + Math.abs(i - 4) * 0.012
        burst(a, t + at, 0.009, "bandpass", 2300 + Math.random() * 500, 1.1, 0.06 - Math.abs(i - 4) * 0.008)
        at += gap
      }
    },
    // A camera shutter: open, the curtain, close.
    shot: function (a, t) {
      burst(a, t, 0.035, "bandpass", 2200, 1, 0.45)
      burst(a, t + 0.02, 0.09, "bandpass", 900, 0.8, 0.16)
      burst(a, t + 0.1, 0.03, "bandpass", 2800, 1.2, 0.3)
    },
    // A soft rising pair of notes for a new page.
    arrive: function (a, t) {
      beep(a, t, 660, 660, 0.22, 0.06)
      beep(a, t + 0.09, 990, 990, 0.3, 0.05)
    },
  }

  /** Plays a sound, "after" milliseconds from now. Silent when sounds are off or the page has no audio. */
  function play(kind, after) {
    var a = context()
    if (!a) return
    try {
      SOUNDS[kind](a, a.currentTime + (after || 0) / 1000)
    } catch (error) {}
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

  /**
   * Where the arrow is drawn right now. Mid-glide that is somewhere along the
   * way, not where the glide will end, and a new move has to leave from there
   * or the arrow jumps.
   */
  function drawn() {
    if (!state.motion || state.motion.playState !== "running") return { x: state.x, y: state.y }
    var match = /matrix\(([^)]+)\)/.exec(getComputedStyle(state.pointer).transform)
    if (!match) return { x: state.x, y: state.y }
    var parts = match[1].split(",")
    var x = parseFloat(parts[4])
    var y = parseFloat(parts[5])
    if (!isFinite(x) || !isFinite(y)) return { x: state.x, y: state.y }
    return { x: x + 3, y: y + 2 }
  }

  /** Stops a glide still under way, so two never fight over the arrow. */
  function halt() {
    if (state.motion) state.motion.cancel()
    if (state.drift) state.drift.cancel()
    state.motion = null
    state.drift = null
  }

  function place(x, y) {
    state.x = onScreen(x, innerWidth)
    state.y = onScreen(y, innerHeight)
    if (!build()) return
    halt()
    state.pointer.style.transform = at(state.x, state.y)
    state.trail.style.transform = dot(state.x, state.y)
    wake()
  }

  function move(x, y, duration) {
    if (!build()) return
    var from = drawn()
    var fromX = from.x
    var fromY = from.y
    halt()
    state.x = onScreen(x, innerWidth)
    state.y = onScreen(y, innerHeight)
    state.pointer.style.transform = at(state.x, state.y)
    state.trail.style.transform = dot(state.x, state.y)
    if (duration > 0 && state.pointer.animate) {
      var path = reach(fromX, fromY, state.x, state.y)
      state.motion = state.pointer.animate(frames(path, at), { duration: duration, easing: "linear" })
      // The arrow leans the way it travels and straightens as it brakes, like a hand-held object.
      var distance = Math.sqrt((state.x - fromX) * (state.x - fromX) + (state.y - fromY) * (state.y - fromY))
      if (distance > STRAIGHT) {
        var lean = Math.max(-LEAN, Math.min(LEAN, ((state.x - fromX) / distance) * LEAN))
        state.body.animate(
          [{ rotate: "0deg" }, { rotate: lean + "deg", offset: 0.3 }, { rotate: lean * -0.15 + "deg", offset: 0.85 }, { rotate: "0deg" }],
          { duration: duration, easing: "ease-out" }
        )
      }
      // The trail leaves with the arrow and arrives after it, which is what
      // makes the move read as one gesture rather than a jump.
      state.drift = state.trail.animate(frames(path, dot), {
        duration: duration + Math.round(duration * TRAIL_LAG),
        easing: "linear",
      })
    }
    wake()
  }

  /**
   * The way a hand moves a mouse, as points in time: never a straight line
   * over any distance but a slight arc to one side; speed that builds up, peaks
   * mid-way and brakes into the target (the minimum-jerk profile of a human
   * reach); on a long reach a small overshoot and a correction back; and the
   * faint tremor of a hand that is never perfectly still. Each point is
   * { x, y, at } with "at" from 0 to 1.
   */
  function reach(fromX, fromY, toX, toY) {
    var dx = toX - fromX
    var dy = toY - fromY
    var distance = Math.sqrt(dx * dx + dy * dy)
    if (distance < 1) return [{ x: toX, y: toY, at: 0 }, { x: toX, y: toY, at: 1 }]
    var ux = dx / distance
    var uy = dy / distance
    // The perpendicular, for the arc and the tremor.
    var nx = -uy
    var ny = ux
    var side = Math.random() < 0.5 ? -1 : 1
    var bend = distance < STRAIGHT ? 0 : distance * (0.06 + Math.random() * 0.12) * side
    var over = distance < OVERSHOOT ? 0 : Math.min(16, distance * 0.035) * (0.6 + Math.random() * 0.7)
    // Where the hand actually heads: a little past the target, slightly off its line.
    var endX = toX + ux * over + nx * over * 0.35 * side
    var endY = toY + uy * over + ny * over * 0.35 * side
    var c1x = fromX + dx * 0.28 + nx * bend
    var c1y = fromY + dy * 0.28 + ny * bend
    var c2x = fromX + dx * 0.72 + nx * bend * 0.55
    var c2y = fromY + dy * 0.72 + ny * bend * 0.55
    // The main reach takes most of the time; a correction takes the rest.
    var main = over > 0 ? 0.82 : 1
    var steps = Math.max(8, Math.min(26, Math.round(distance / 22)))
    var points = []
    for (var i = 0; i <= steps; i++) {
      var u = i / steps
      var s = u * u * u * (10 - 15 * u + 6 * u * u)
      var r = 1 - s
      var x = r * r * r * fromX + 3 * r * r * s * c1x + 3 * r * s * s * c2x + s * s * s * endX
      var y = r * r * r * fromY + 3 * r * r * s * c1y + 3 * r * s * s * c2y + s * s * s * endY
      if (i > 0 && i < steps) {
        var shake = (Math.random() - 0.5) * 0.9
        x += nx * shake
        y += ny * shake
      }
      points.push({ x: x, y: y, at: u * main })
    }
    if (over > 0) {
      // Back onto the target, braking all the way.
      points.push({ x: toX + (endX - toX) * 0.3, y: toY + (endY - toY) * 0.3, at: main + (1 - main) * 0.45 })
      points.push({ x: toX, y: toY, at: 1 })
    }
    return points
  }

  function frames(points, place) {
    var list = []
    for (var i = 0; i < points.length; i++) list.push({ transform: place(points[i].x, points[i].y), offset: points[i].at })
    return list
  }

  /** How long a person takes to reach a target this far away and this big, in milliseconds. */
  function reachTime(distance, width, height) {
    var size = Math.max(8, Math.min(width || 40, height || 40))
    var bits = Math.log(distance / size + 1) / Math.LN2
    return Math.round(Math.max(REACH_MIN, Math.min(REACH_MAX, REACH_START + REACH_PER_BIT * bits)))
  }

  function highlight(x, y, width, height, duration, name) {
    if (!build()) return
    var box = state.box
    var text = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : ""
    state.label.textContent = text.length > 40 ? text.slice(0, 39) + "…" : text
    state.label.style.display = text ? "block" : "none"
    // Near the top of the window the tab would be cut off, so it hangs below instead.
    state.label.style.bottom = y < 24 ? "auto" : "calc(100% + 3px)"
    state.label.style.top = y < 24 ? "calc(100% + 3px)" : "auto"
    box.style.left = x - 4 + "px"
    box.style.top = y - 4 + "px"
    box.style.width = width + 8 + "px"
    box.style.height = height + 8 + "px"
    var spot = state.spot
    spot.style.left = x - 6 + "px"
    spot.style.top = y - 6 + "px"
    spot.style.width = width + 12 + "px"
    spot.style.height = height + 12 + "px"
    if (spot.animate) {
      // Gone again before the press lands, so a picture taken right after shows the page as it is.
      spot.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.55 }, { opacity: 0, offset: 0.8 }, { opacity: 0 }],
        { duration: duration || 700, easing: "ease-out" }
      )
    }
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
  function glide(px, py, x, y, width, height, name) {
    if (!build()) return 0
    var dx = px - state.x
    var dy = py - state.y
    var distance = Math.sqrt(dx * dx + dy * dy)
    var duration = distance < 2 ? 0 : reachTime(distance, width, height)
    highlight(x, y, width, height, duration + 500, name)
    move(px, py, duration)
    return duration ? Math.round(duration * PRESS_AT) + PRESS_BEAT : 0
  }

  /**
   * The element moved a little between aiming and pressing: the outline moves
   * with it and the arrow slides the last few pixels, without starting the
   * whole reach (and the outline's flash) over again.
   */
  function follow(px, py, x, y, width, height) {
    if (!build()) return
    var box = state.box
    box.style.left = x - 4 + "px"
    box.style.top = y - 4 + "px"
    box.style.width = width + 8 + "px"
    box.style.height = height + 8 + "px"
    move(px, py, 90)
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
    if (state.body.animate) {
      state.body.animate(
        [{ scale: "1" }, { scale: "0.8" }, { scale: "1.06" }, { scale: "1" }],
        { duration: 240, easing: "ease-out" }
      )
    }
    play("click")
    wake()
  }

  /**
   * Keys being typed: a tick for each of the first ones, spread over how long
   * the typing takes, and the tag saying so meanwhile.
   */
  function typing(count, duration) {
    if (!build()) return
    // The field being filled lights up with a tag, so it is clear where the words are going.
    var field = document.activeElement
    if (field && field !== document.body && field.getBoundingClientRect) {
      var rect = field.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0)
        highlight(rect.left, rect.top, rect.width, rect.height, Math.max(900, (duration || 300) + 600), "digitando…")
    }
    var ticks = Math.max(1, Math.min(count || 1, 24))
    var span = Math.max(60, duration || 300)
    for (var i = 0; i < ticks; i++) play("key", (span / ticks) * i + Math.random() * 18)
    if (state.body.animate) {
      state.body.animate([{ translate: "0 0" }, { translate: "0 1px" }, { translate: "0 0" }], {
        duration: 120,
        iterations: Math.max(1, Math.round(span / 120)),
      })
    }
    wake()
  }

  /** A single key, such as Enter or Escape. */
  function key() {
    if (!build()) return
    play("key")
    wake()
  }

  /** The wheel by the arrow turning the way the page scrolls; "direction" is 1 for down, -1 for up. */
  function scroll(direction) {
    if (!build()) return
    var down = direction >= 0
    var wheel = state.wheel
    wheel.style.left = state.x - 19 + "px"
    wheel.style.top = state.y - 4 + "px"
    if (wheel.animate) {
      wheel.animate(
        [
          { opacity: 0, transform: "translateY(0)" },
          { opacity: 1, transform: "translateY(0)", offset: 0.15 },
          { opacity: 1, transform: "translateY(" + (down ? 3 : -3) + "px)", offset: 0.75 },
          { opacity: 0, transform: "translateY(" + (down ? 5 : -5) + "px)" }
        ],
        { duration: 650, easing: "ease-out" }
      )
      state.notch.animate(
        [{ transform: "translateY(" + (down ? -4 : 4) + "px)" }, { transform: "translateY(" + (down ? 4 : -4) + "px)" }],
        { duration: 220, iterations: 3, easing: "ease-in" }
      )
    }
    rail()
    play("scroll")
    wake()
  }

  /** Shows the rail on the right edge for a moment, its thumb following the page as it moves. */
  function rail() {
    var scroller = document.scrollingElement || document.documentElement
    var room = scroller.scrollHeight - innerHeight
    if (!(room > 8)) return
    var until = Date.now() + 1100
    state.rail.style.opacity = "1"
    state.thumb.style.height = Math.max(10, Math.min(60, (innerHeight / scroller.scrollHeight) * 100)) + "%"
    if (state.railing) return
    var follow = function () {
      var max = scroller.scrollHeight - innerHeight
      var ratio = max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0
      state.thumb.style.top = ratio * (100 - parseFloat(state.thumb.style.height)) + "%"
      if (Date.now() < until) {
        state.railing = requestAnimationFrame(follow)
        return
      }
      state.railing = 0
      state.rail.style.opacity = "0"
    }
    state.railing = requestAnimationFrame(follow)
  }

  /** The page lighting up and a shutter, once the picture has been taken. */
  function shot() {
    if (!build()) return
    if (state.flash.animate) {
      state.flash.animate([{ opacity: 0 }, { opacity: 0.45, offset: 0.2 }, { opacity: 0 }], {
        duration: 320,
        easing: "ease-out",
      })
    }
    play("shot")
    wake()
  }

  /**
   * The arrow back on a new document, popping in where it was. "loud" when the
   * agent brought the page here just now, which is worth a sound.
   */
  function arrive(x, y, loud) {
    place(x, y)
    if (!state.body) return
    // Only a quick fade: the arrow is where it was on the page before, so it should read as never having left.
    if (state.body.animate) state.body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" })
    if (loud) play("arrive")
  }

  /**
   * Says what the agent is doing: "short" on the tag, or on the card "title"
   * (or "short") with "body" and "status" under it. "hold" keeps it up while
   * work goes on off the page; otherwise it goes once the agent is quiet.
   */
  function say(thought) {
    if (!build()) return
    var o = thought || {}
    clearTimeout(state.quiet)
    state.tag.textContent = where === "cursor" ? clip(o.short) || "IA" : "IA"
    // Near the right edge the words would run off the window, so they hang to the left of the arrow.
    var flip = state.x > innerWidth - 250
    state.tag.style.left = flip ? "auto" : "15px"
    state.tag.style.right = flip ? "18px" : "auto"
    if (where === "card") note(o)
    else fold()
    state.quiet = setTimeout(quiet, o.hold ? 600000 : LINGER)
    wake()
  }

  function clip(text) {
    return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : ""
  }

  function note(o) {
    var line = clip(o.title) || clip(o.short)
    var before = state.now.textContent
    if (before && line && before !== line) state.said = [before].concat(state.said).slice(0, PAST)
    state.now.textContent = line
    state.detail.textContent = typeof o.body === "string" ? o.body.trim() : ""
    state.detail.style.display = state.detail.textContent ? "-webkit-box" : "none"
    state.status.textContent = clip(o.status)
    state.status.style.display = state.status.textContent ? "block" : "none"
    while (state.past.firstChild) state.past.removeChild(state.past.firstChild)
    for (var i = 0; i < state.said.length; i++) {
      var row = document.createElement("div")
      row.textContent = state.said[i]
      row.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:" + (1 - i * 0.35) + ";"
      state.past.appendChild(row)
    }
    if (state.beat) state.beat.cancel()
    state.beat =
      o.hold && state.pulse.animate
        ? state.pulse.animate([{ opacity: 1 }, { opacity: 0.25 }], { duration: 700, iterations: Infinity, direction: "alternate" })
        : null
    var card = state.card
    if (card.style.display !== "block") {
      card.style.display = "block"
      // Read the layout once so the fade in starts from the hidden state.
      void card.offsetHeight
    }
    card.style.opacity = "1"
    card.style.transform = "translateY(0)"
  }

  function fold() {
    var card = state.card
    if (!card || card.style.display === "none") return
    card.style.opacity = "0"
    card.style.transform = "translateY(8px)"
    setTimeout(function () {
      if (card.style.opacity === "0") card.style.display = "none"
    }, 240)
  }

  /** The agent has gone quiet: the tag says only whose arrow it is, and the card folds away. */
  function quiet() {
    if (state.tag) state.tag.textContent = "IA"
    state.said = []
    if (state.now) state.now.textContent = ""
    if (state.beat) state.beat.cancel()
    state.beat = null
    fold()
  }

  /** Lights the glow without moving, for actions that have no target, like typing or scrolling. */
  function busy() {
    if (!build()) return
    wake()
  }

  /**
   * X-ray: a thin box with its ref_N tag around every element the agent can
   * act on, the page as the agent sees it. Follows scrolling while it is on.
   */
  function xray(on) {
    if (!build()) return
    if (state.xray) {
      state.xray.remove()
      removeEventListener("scroll", state.xrayDraw, true)
      removeEventListener("resize", state.xrayDraw)
      state.xray = null
    }
    if (!on) return
    var layer = document.createElement("div")
    layer.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;"
    // Inside the overlay's own (closed) shadow root, so the page and its serialized HTML never see it.
    state.root.appendChild(layer)
    var draw = function () {
      while (layer.firstChild) layer.removeChild(layer.firstChild)
      var found = document.querySelectorAll("[data-oc-ref]")
      var shown = 0
      for (var i = 0; i < found.length && shown < 400; i++) {
        var rect = found[i].getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > innerHeight) continue
        shown++
        var box = document.createElement("div")
        box.style.cssText =
          "position:fixed;box-sizing:border-box;border:1px solid " + tone(0.9) + ";background:" + tone(0.07) +
          ";border-radius:3px;left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px;"
        var tag = document.createElement("span")
        tag.textContent = found[i].getAttribute("data-oc-ref")
        tag.style.cssText =
          "position:absolute;left:-1px;top:-13px;padding:0 3px;border-radius:3px 3px 0 0;background:" + tone(1) +
          ";color:#0b0b10;font:600 9px/13px ui-monospace,Consolas,monospace;white-space:nowrap;"
        box.appendChild(tag)
        layer.appendChild(box)
      }
    }
    draw()
    state.xray = layer
    state.xrayDraw = draw
    addEventListener("scroll", draw, true)
    addEventListener("resize", draw)
  }

  function hide(hidden) {
    if (state.host) state.host.style.display = hidden ? "none" : "block"
  }

  var api = {
    place: place,
    move: move,
    glide: glide,
    click: click,
    highlight: highlight,
    busy: busy,
    hide: hide,
    tint: tint,
    configure: configure,
    follow: follow,
    typing: typing,
    key: key,
    scroll: scroll,
    shot: shot,
    arrive: arrive,
    say: say,
    xray: xray,
  }
  // Not enumerable, so it does not show up for pages that walk window.
  Object.defineProperty(window, KEY, { value: api, configurable: true, enumerable: false })
  return api
})`

/** The tag of the overlay's host element, stripped from serialized HTML. */
export const HOST_TAG = "oc-agent-cursor"

export * as BrowserCursor from "./cursor"
