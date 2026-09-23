import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js"
import "./scope.css"

/** Beam speed along the panel edge (px/s); a lap takes the whole perimeter at this pace. */
const SPEED = 600
const LAP_MIN = 3200
const LAP_MAX = 8000
/** The line runs this far inside the edge, so the panel's clipping never cuts it in half. */
const INSET = 1
/** Samples per rounded corner; the beam moves in straight steps between them. */
const ARC_STEPS = 6
/**
 * Phosphor tail: segments trailing the head this many px apart, fading as they go.
 * Each one is a tent twice as long as the spacing, so neighbors add up (plus-lighter)
 * to one smooth ramp instead of a string of beads.
 */
const TAIL = 18
const SPACING = 8
/** Matches the fade-out in scope.css; the loops stop once it is over. */
const FADE_OUT = 520

const TAIL_SEGMENTS = Array.from({ length: TAIL }, (_, index) => index + 1)

function tailOpacity(index: number) {
  return (1 - index / (TAIL + 1)) ** 1.8 * 0.9
}

type Lap = { length: number; keyframes: Keyframe[]; path: string }

/**
 * The panel edge as one clockwise lap, starting under the composer (bottom center).
 * Keyframe offsets follow the distance travelled, so the beam keeps one speed on
 * straight edges and corners alike; the angle only grows, so it never spins back.
 */
function edgeLap(width: number, height: number, radius: number): Lap {
  const x0 = INSET
  const y0 = INSET
  const x1 = width - INSET
  const y1 = height - INSET
  const r = Math.max(0, Math.min(radius - INSET, (x1 - x0) / 2, (y1 - y0) / 2))
  const points: { x: number; y: number; angle: number; at: number }[] = []
  let at = 0

  const add = (x: number, y: number, angle: number, travelled: number) => {
    at += travelled
    points.push({ x, y, angle, at })
  }
  const straightTo = (x: number, y: number, angle: number) => {
    const last = points[points.length - 1]
    add(x, y, angle, Math.hypot(x - last.x, y - last.y))
  }

  add(width / 2, y1, 180, 0)
  const corners = [
    { cx: x0 + r, cy: y1 - r, from: 90 },
    { cx: x0 + r, cy: y0 + r, from: 180 },
    { cx: x1 - r, cy: y0 + r, from: 270 },
    { cx: x1 - r, cy: y1 - r, from: 360 },
  ]
  for (const corner of corners) {
    const start = (corner.from * Math.PI) / 180
    straightTo(corner.cx + r * Math.cos(start), corner.cy + r * Math.sin(start), corner.from + 90)
    for (let step = 1; step <= ARC_STEPS; step++) {
      const phi = corner.from + (90 * step) / ARC_STEPS
      const rad = (phi * Math.PI) / 180
      add(corner.cx + r * Math.cos(rad), corner.cy + r * Math.sin(rad), phi + 90, (r * Math.PI) / 2 / ARC_STEPS)
    }
  }
  straightTo(width / 2, y1, 540)

  const length = at || 1
  return {
    length,
    keyframes: points.map((point) => ({
      offset: point.at / length,
      transform: `translate(${point.x}px, ${point.y}px) rotate(${point.angle}deg)`,
    })),
    path: [
      `M ${width / 2} ${y1} H ${x0 + r}`,
      `A ${r} ${r} 0 0 1 ${x0} ${y1 - r} V ${y0 + r}`,
      `A ${r} ${r} 0 0 1 ${x0 + r} ${y0} H ${x1 - r}`,
      `A ${r} ${r} 0 0 1 ${x1} ${y0 + r} V ${y1 - r}`,
      `A ${r} ${r} 0 0 1 ${x1 - r} ${y1} Z`,
    ].join(" "),
  }
}

/**
 * The response signature: while the agent works, a phosphor beam runs around the
 * chat panel's edge at constant speed and writes a thin frame in the live trace
 * color on its first lap. The beam only moves by transform (compositor work, so a
 * busy main thread never stutters it) and every loop stops once the trace is out.
 */
export function ScopeTrace(props: { active: boolean }) {
  const [lit, setLit] = createSignal(false)
  let root!: HTMLDivElement
  let frame!: SVGPathElement
  let head!: HTMLSpanElement
  let bloom!: HTMLSpanElement
  const tail: HTMLSpanElement[] = []
  let running = false
  let beams: Animation[] = []
  let reveal: Animation | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined

  const reducedMotion = () =>
    document.documentElement.hasAttribute("data-lite") || window.matchMedia("(prefers-reduced-motion: reduce)").matches

  /** Lays the frame and the beam on the current panel size; `progress` is the head's place in the lap (0–1). */
  const run = (progress: number, revealing: boolean) => {
    const box = root.getBoundingClientRect()
    if (box.width < 40 || box.height < 40) return
    const lap = edgeLap(box.width, box.height, parseFloat(getComputedStyle(root).borderTopLeftRadius) || 0)
    frame.setAttribute("d", lap.path)
    for (const beam of beams) beam.cancel()
    beams = []
    reveal?.cancel()
    reveal = undefined

    if (reducedMotion()) {
      frame.style.strokeDasharray = "none"
      return
    }

    const duration = Math.min(LAP_MAX, Math.max(LAP_MIN, (lap.length / SPEED) * 1000))
    const now = progress * duration
    const lag = (SPACING / lap.length) * duration
    const beam = (element: HTMLElement, behind: number) => {
      const animation = element.animate(lap.keyframes, { duration, iterations: Infinity, fill: "backwards" })
      animation.currentTime = now - behind
      beams.push(animation)
    }
    beam(head, 0)
    beam(bloom, 0)
    tail.forEach((segment, index) => beam(segment, (index + 1) * lag))

    if (!revealing) {
      frame.style.strokeDasharray = "none"
      return
    }
    // The first lap writes the frame right behind the head.
    const total = frame.getTotalLength()
    frame.style.strokeDasharray = `${total} ${total}`
    reveal = frame.animate([{ strokeDashoffset: `${total}` }, { strokeDashoffset: "0" }], { duration, fill: "both" })
    reveal.currentTime = now
  }

  const progress = () => {
    const current = Number(beams[0]?.currentTime ?? 0)
    const duration = Number(beams[0]?.effect?.getTiming().duration ?? 1)
    return (current % duration) / duration
  }

  const start = () => {
    clearTimeout(stopTimer)
    stopTimer = undefined
    if (running) return
    running = true
    setLit(true)
    run(0, true)
  }

  const stop = () => {
    running = false
    for (const beam of beams) beam.cancel()
    beams = []
    reveal?.cancel()
    reveal = undefined
    setLit(false)
  }

  onMount(() => {
    const observer = new ResizeObserver(() => {
      if (!running) return
      run(progress(), reveal?.playState === "running")
    })
    observer.observe(root)
    onCleanup(() => {
      observer.disconnect()
      clearTimeout(stopTimer)
      stop()
    })
  })

  createEffect(() => {
    if (props.active) return start()
    if (!lit() || stopTimer) return
    stopTimer = setTimeout(() => {
      stopTimer = undefined
      stop()
    }, FADE_OUT)
  })

  return (
    <div
      ref={root}
      class="scope-trace"
      data-active={props.active ? "" : undefined}
      data-chroma={lit() ? "" : undefined}
      aria-hidden="true"
    >
      <svg class="scope-trace-frame">
        <path ref={frame} />
      </svg>
      <span ref={bloom} class="scope-trace-beam scope-trace-bloom" />
      <For each={TAIL_SEGMENTS}>
        {(index) => (
          <span
            ref={(element) => (tail[index - 1] = element)}
            class="scope-trace-beam scope-trace-tail"
            style={{ width: `${SPACING * 2}px`, "margin-left": `${-SPACING}px`, opacity: tailOpacity(index) }}
          />
        )}
      </For>
      <span ref={head} class="scope-trace-beam scope-trace-head" />
    </div>
  )
}
