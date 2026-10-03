/**
 * The app's movements that need JavaScript: crossing into another space, the
 * selection pill that slides between options, a sent prompt rising into the
 * chat, and the writing front of a live answer.
 *
 * Every one of them is set off by an event and runs once. They read the motion
 * level each time: reduced motion turns them off, Lite mode (on by default)
 * keeps them but shorter, since they are cheap and tell the person something
 * changed. Times and curves match the tokens in `ui/src/v2/styles/scope.css`.
 */

export const EASE = {
  out: "cubic-bezier(0.2, 0, 0, 1)",
  spring: "cubic-bezier(0.34, 1.32, 0.64, 1)",
  inout: "cubic-bezier(0.65, 0, 0.35, 1)",
}

export function motionLevel() {
  if (typeof window === "undefined") return "none"
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "none"
  return document.documentElement.hasAttribute("data-lite") ? "lite" : "full"
}

// Where the last press landed, so a space change it caused can grow from there.
let press: { x: number; y: number; at: number } | undefined
if (typeof document !== "undefined")
  document.addEventListener(
    "pointerdown",
    (event) => {
      press = { x: event.clientX, y: event.clientY, at: performance.now() }
    },
    { capture: true, passive: true },
  )

/**
 * Applies a change of space. When a click caused it, the new color spreads in a
 * circle from where the click landed; anything else (a keyboard switch, a route
 * restored on load) changes it at once.
 */
export function crossSpace(apply: () => void) {
  const level = motionLevel()
  const origin = press && performance.now() - press.at < 800 ? press : undefined
  if (level === "none" || !origin || !document.startViewTransition) return apply()
  press = undefined
  const end = Math.hypot(
    Math.max(origin.x, window.innerWidth - origin.x),
    Math.max(origin.y, window.innerHeight - origin.y),
  )
  const transition = document.startViewTransition(apply)
  transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${end}px at ${origin.x}px ${origin.y}px)`],
        },
        { duration: level === "lite" ? 300 : 460, easing: EASE.inout, pseudoElement: "::view-transition-new(root)" },
      )
    })
    .catch(() => undefined)
}

/**
 * One selection marker that travels between the options of a group instead of
 * one option going dark and another lighting up. The options keep their own
 * selected style; while the selection moves, a copy of that style glides from
 * the old option to the new one (stretching over both on the way, outside Lite
 * mode) and hands over when it arrives. Returns the cleanup.
 */
export function slidingPill(root: HTMLElement, options: { active: string }) {
  const find = () => root.querySelector<HTMLElement>(options.active) ?? undefined
  const look = (el: HTMLElement) => {
    const style = getComputedStyle(el)
    return { background: style.backgroundColor, shadow: style.boxShadow, radius: style.borderRadius }
  }
  let current: HTMLElement | undefined
  let currentLook: ReturnType<typeof look> | undefined
  // Read once the group is on screen; a group still being mounted has no style yet.
  requestAnimationFrame(() => {
    current = find()
    currentLook = current ? look(current) : undefined
  })
  let flight: { overlay: HTMLElement; animation: Animation; done: () => void } | undefined

  const move = () => {
    const next = find()
    if (next === current) return
    const previous = current
    const previousLook = currentLook
    current = next
    const level = motionLevel()
    if (!next) return
    // The new option's own style, read with its transition held so it is the
    // final one rather than wherever a hover fade happens to be.
    next.style.transition = "none"
    currentLook = look(next)
    if (!previous || !previousLook || !previous.isConnected || level === "none") {
      next.style.transition = ""
      return
    }

    const box = root.getBoundingClientRect()
    const place = (rect: DOMRect) => ({
      x: rect.left - box.left - root.clientLeft + root.scrollLeft,
      y: rect.top - box.top - root.clientTop + root.scrollTop,
      w: rect.width,
      h: rect.height,
    })
    // A move that starts mid-flight starts from where the marker is now.
    const from = flight ? place(flight.overlay.getBoundingClientRect()) : place(previous.getBoundingClientRect())
    const fromLook = flight ? look(flight.overlay) : previousLook
    flight?.animation.cancel()
    flight?.done()
    const to = place(next.getBoundingClientRect())

    if (getComputedStyle(root).position === "static") root.style.position = "relative"
    root.style.isolation = "isolate"
    const overlay = document.createElement("span")
    overlay.setAttribute("aria-hidden", "true")
    overlay.style.cssText = "position:absolute;left:0;top:0;z-index:-1;pointer-events:none;"
    root.appendChild(overlay)
    previous.style.transition = "none"
    previous.setAttribute("data-pill-moving", "")
    next.setAttribute("data-pill-moving", "")

    const frame = (at: { x: number; y: number; w: number; h: number }, style: typeof fromLook) => ({
      transform: `translate(${at.x}px, ${at.y}px)`,
      width: `${at.w}px`,
      height: `${at.h}px`,
      backgroundColor: style.background,
      boxShadow: style.shadow,
      borderRadius: style.radius,
    })
    const left = Math.min(from.x, to.x)
    const top = Math.min(from.y, to.y)
    const span = {
      x: left,
      y: top,
      w: Math.max(from.x + from.w, to.x + to.w) - left,
      h: Math.max(from.y + from.h, to.y + to.h) - top,
    }
    const frames =
      level === "lite"
        ? [frame(from, fromLook), frame(to, currentLook)]
        : // Leave quickly to stretch over both, then land on the new one with the spring.
          [
            { ...frame(from, fromLook), easing: EASE.out },
            { ...frame(span, fromLook), offset: 0.4, easing: "cubic-bezier(0.34, 1.18, 0.64, 1)" },
            frame(to, currentLook),
          ]
    const animation = overlay.animate(frames, {
      duration: level === "lite" ? 200 : 440,
      easing: level === "lite" ? EASE.out : "linear",
    })
    const done = () => {
      overlay.remove()
      for (const el of [previous, next]) {
        el.removeAttribute("data-pill-moving")
        // Hand over without the option fading its own style in again.
        void el.offsetWidth
        el.style.transition = ""
      }
      if (flight?.overlay === overlay) flight = undefined
    }
    flight = { overlay, animation, done }
    animation.finished.then(done, () => undefined)
  }

  const observer = new MutationObserver(move)
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-checked", "aria-selected", "data-selected", "data-active"],
  })
  return () => {
    observer.disconnect()
    flight?.animation.cancel()
    flight?.done()
  }
}

/**
 * A prompt that was just sent rises from the composer into its place in the
 * chat, so it is plain where it went. Called with the composer's box right
 * before it is cleared; the message it becomes is caught when it appears.
 */
export function launchFlight(text: string, from: DOMRect | undefined) {
  const key = text.replace(/\s+/g, " ").trim().slice(0, 28)
  if (!from || !key || motionLevel() === "none") return
  const seen = new Set(document.querySelectorAll('[data-component="user-message"]'))
  const land = (message: HTMLElement) => {
    const body = message.querySelector<HTMLElement>('[data-slot="user-message-body"]') ?? message
    body.style.opacity = "0"
    // One frame later, once the timeline has scrolled to it, so the rise ends where it stays.
    requestAnimationFrame(() => {
      body.style.opacity = ""
      const to = body.getBoundingClientRect()
      const level = motionLevel()
      body.animate(
        [
          { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(0.98)`, opacity: 0.35 },
          { transform: "none", opacity: 1 },
        ],
        { duration: level === "lite" ? 300 : 480, easing: level === "lite" ? EASE.out : EASE.spring },
      )
    })
  }
  const observer = new MutationObserver(() => {
    const message = [...document.querySelectorAll<HTMLElement>('[data-component="user-message"]')].find(
      (el) => !seen.has(el) && (el.textContent ?? "").replace(/\s+/g, " ").includes(key),
    )
    if (!message) return
    stop()
    land(message)
  })
  const timer = setTimeout(() => stop(), 2500)
  const stop = () => {
    observer.disconnect()
    clearTimeout(timer)
  }
  observer.observe(document.body, { subtree: true, childList: true })
}

/**
 * A prompt sent while the agent works goes to the follow-up queue: its text
 * flies from the composer into the queue, which bumps as it lands, so it is
 * plain the prompt waits there instead of being lost.
 */
export function queueFlight(text: string, from: DOMRect | undefined) {
  const level = motionLevel()
  const label = text.replace(/\s+/g, " ").trim()
  if (!from || !label || level === "none") return
  // Two frames, so a queue shown for the first time has its place.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const dock = document.querySelector<HTMLElement>('[data-component="session-followup-dock"]')
      if (!dock) return
      const target = [...dock.querySelectorAll<HTMLElement>("[data-followup-item]")].at(-1) ?? dock
      const to = target.getBoundingClientRect()
      const bump = () =>
        target.animate([{ transform: "none" }, { transform: "scale(1.03)" }, { transform: "none" }], {
          duration: level === "lite" ? 200 : 360,
          easing: EASE.out,
        })
      if (level === "lite") return void bump()
      const ghost = document.createElement("div")
      ghost.setAttribute("aria-hidden", "true")
      ghost.textContent = label.length > 60 ? `${label.slice(0, 59)}…` : label
      ghost.style.cssText =
        `position:fixed;left:0;top:0;z-index:60;pointer-events:none;max-width:${Math.max(160, to.width)}px;` +
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:6px 10px;border-radius:10px;font-size:13px;" +
        "color:var(--v2-text-text-base);background:var(--v2-background-bg-layer-02);box-shadow:var(--v2-elevation-floating);"
      document.body.appendChild(ghost)
      ghost
        .animate(
          [
            { transform: `translate(${from.left}px, ${from.top}px)`, opacity: 0.9 },
            { transform: `translate(${to.left}px, ${to.top}px) scale(0.92)`, opacity: 0.2 },
          ],
          { duration: 460, easing: EASE.inout },
        )
        .finished.then(bump, () => undefined)
        .finally(() => ghost.remove())
    }),
  )
}

/**
 * A card that takes the composer's place (a permission, a question) rises
 * into it from the composer's edge, so it reads as the agent asking in the
 * spot where you answer. Use as a `ref`.
 */
export function riseIn(el: HTMLElement) {
  const level = motionLevel()
  if (level === "none") return
  el.animate(
    [
      { transform: "translateY(14px) scaleY(0.94)", opacity: 0, transformOrigin: "bottom" },
      { transform: "none", opacity: 1, transformOrigin: "bottom" },
    ],
    { duration: level === "lite" ? 220 : 420, easing: level === "lite" ? EASE.out : EASE.spring, fill: "backwards" },
  )
}

let stoppedAt = -Infinity

/**
 * The brake: when the person stops the agent, the session's endless "working"
 * movements slow to a halt instead of vanishing mid-stride, so it reads as
 * stopping. If the work carries on after all, they pick up again.
 */
export function brake() {
  stoppedAt = performance.now()
  const level = motionLevel()
  if (level === "none") return
  const running = document
    .getAnimations()
    .filter(
      (animation) =>
        animation.effect?.getTiming().iterations === Infinity &&
        animation.effect instanceof KeyframeEffect &&
        animation.effect.target?.closest('[data-component="session-workspace"]'),
    )
  if (!running.length) return
  const start = performance.now()
  const slow = (now: number) => {
    const progress = Math.min(1, (now - start) / 420)
    running.forEach((animation) => (animation.playbackRate = Math.max(0.001, (1 - progress) ** 2)))
    if (progress < 1) return void requestAnimationFrame(slow)
    running.forEach((animation) => animation.pause())
    setTimeout(
      () =>
        running.forEach((animation) => {
          if (!(animation.effect instanceof KeyframeEffect) || !animation.effect.target?.isConnected) return
          animation.playbackRate = 1
          animation.play()
        }),
      3000,
    )
  }
  requestAnimationFrame(slow)
}

/**
 * The "interrupted" mark of a turn the person just stopped drops in like a
 * stamp. Marks scrolled back into view later just appear. Use as a `ref`.
 */
export function stamp(el: HTMLElement) {
  const level = motionLevel()
  if (level === "none" || performance.now() - stoppedAt > 6000) return
  // A ref runs before the divider's children are in; they are by the next microtask.
  queueMicrotask(() => drop(el, level))
}

function drop(el: HTMLElement, level: "lite" | "full") {
  const label = el.querySelector<HTMLElement>('[data-slot="compaction-part-label"]')
  label?.animate(
    [
      { transform: "translateY(-8px) rotate(-6deg)", opacity: 0 },
      { transform: "none", opacity: 1 },
    ],
    { duration: level === "lite" ? 220 : 400, easing: level === "lite" ? EASE.out : EASE.spring },
  )
  el.querySelectorAll<HTMLElement>('[data-slot="compaction-part-line"]').forEach((line) =>
    line.animate([{ transform: "scaleX(0)" }, { transform: "none" }], {
      duration: level === "lite" ? 220 : 480,
      easing: EASE.out,
    }),
  )
}

/**
 * A small chip that travels along an arc from one place to another (a
 * response's cost to today's spend), then resolves so the destination can
 * take the value in. Lite mode makes it a short hop onto the destination.
 */
export function flyChip(text: string, from: DOMRect, to: DOMRect) {
  const level = motionLevel()
  if (level === "none") return Promise.resolve()
  const chip = document.createElement("span")
  chip.setAttribute("aria-hidden", "true")
  chip.textContent = text
  chip.style.cssText =
    "position:fixed;left:0;top:0;z-index:70;pointer-events:none;white-space:nowrap;padding:2px 7px;border-radius:99px;" +
    "font:500 11px/1.4 var(--font-family-mono, monospace);color:var(--space-on, #0b0b10);background:var(--space);" +
    "box-shadow:0 6px 16px -6px var(--space);"
  document.body.appendChild(chip)
  const width = chip.offsetWidth
  const endX = to.left + to.width / 2 - width / 2
  const endY = to.top + to.height / 2 - 9
  const frames =
    level === "lite"
      ? [
          { transform: `translate(${endX}px, ${endY + 14}px)`, opacity: 0 },
          { transform: `translate(${endX}px, ${endY}px)`, opacity: 1 },
        ]
      : [
          { transform: `translate(${from.left}px, ${from.top}px) scale(0.8)`, opacity: 0 },
          { transform: `translate(${from.left}px, ${from.top - 10}px)`, opacity: 1, offset: 0.15 },
          {
            transform: `translate(${(from.left + endX) / 2 + 40}px, ${Math.min(from.top, endY) - 40}px)`,
            offset: 0.6,
          },
          { transform: `translate(${endX}px, ${endY}px) scale(0.7)`, opacity: 1 },
        ]
  return chip
    .animate(frames, {
      duration: level === "lite" ? 240 : 900,
      easing: "cubic-bezier(0.45, 0, 0.2, 1)",
      fill: "forwards",
    })
    .finished.then(
      () => undefined,
      () => undefined,
    )
    .finally(() =>
      chip
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" })
        .finished.finally(() => chip.remove()),
    )
}

/**
 * Undo, seen as a tape winding back: the turn being undone folds away from
 * its last row up to its prompt, and the prompt then drops back into the
 * composer to be edited. Resolves when the rows are gone from sight, so the
 * undo itself can go ahead.
 */
export async function rewind(userMessageID: string) {
  const level = motionLevel()
  if (level === "none") return
  const rows = [
    ...document.querySelectorAll<HTMLElement>(`[data-timeline-row][data-message-id="${CSS.escape(userMessageID)}"]`),
  ].toReversed()
  if (!rows.length) return
  const from = rows.at(-1)?.querySelector('[data-slot="user-message-body"]')?.getBoundingClientRect()
  const step = level === "lite" ? 0 : 50
  await Promise.all(
    rows.map(
      (row, index) =>
        row.animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: "translateY(-10px) scale(0.97)" },
          ],
          {
            duration: level === "lite" ? 180 : 260,
            delay: Math.min(index, 8) * step,
            easing: EASE.out,
            fill: "forwards",
          },
        ).finished,
    ),
  ).catch(() => undefined)
  // Rows an undo that failed left on the page come back.
  setTimeout(() => rows.forEach((row) => row.isConnected && row.getAnimations().forEach((a) => a.cancel())), 2000)
  // The prompt comes back into the composer where it can be edited.
  if (from)
    requestAnimationFrame(() => {
      const editor = document.querySelector<HTMLElement>('[data-component="prompt-input-v2"] [contenteditable="true"]')
      const to = editor?.getBoundingClientRect()
      if (!editor || !to) return
      editor.animate(
        [
          { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, opacity: 0.4 },
          { transform: "none", opacity: 1 },
        ],
        { duration: level === "lite" ? 260 : 460, easing: level === "lite" ? EASE.out : EASE.spring },
      )
    })
}

/**
 * A fork leaves the conversation as a copy of the chosen message that flies
 * up into the tab strip, where the new session's tab pops open, so it is plain
 * the other version exists and where it lives. Call before navigating, and
 * the returned function after.
 */
export function forkFlight(text: string, from: DOMRect | undefined) {
  const level = motionLevel()
  if (level === "none") return () => undefined
  const label = text.replace(/\s+/g, " ").trim()
  let tries = 0
  const previous = document.querySelector('[data-titlebar-tab][data-active="true"]')
  // The new tab shows up once the route has changed; look for it for a moment.
  const find = () => {
    const active = document.querySelector<HTMLElement>('[data-titlebar-tab][data-active="true"]')
    const tab = active === previous ? undefined : active
    if (!tab && ++tries < 30) return void requestAnimationFrame(find)
    if (!tab) return
    const pop = () =>
      tab.animate(
        [
          { transform: "scale(0.6)", opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        {
          duration: level === "lite" ? 220 : 420,
          easing: level === "lite" ? EASE.out : EASE.spring,
        },
      )
    if (level === "lite" || !from || !label) return void pop()
    const to = tab.getBoundingClientRect()
    const ghost = document.createElement("div")
    ghost.setAttribute("aria-hidden", "true")
    ghost.textContent = label.length > 48 ? `${label.slice(0, 47)}…` : label
    ghost.style.cssText =
      "position:fixed;left:0;top:0;z-index:70;pointer-events:none;white-space:nowrap;padding:6px 10px;border-radius:12px;" +
      "font-size:13px;color:var(--v2-text-text-base);background:var(--v2-background-bg-layer-02);" +
      "box-shadow:var(--v2-elevation-floating);transform-origin:top left;"
    document.body.appendChild(ghost)
    ghost
      .animate(
        [
          { transform: `translate(${from.left}px, ${from.top}px)`, opacity: 1 },
          { transform: `translate(${from.left}px, ${from.top - 12}px) scale(1.03)`, offset: 0.2 },
          { transform: `translate(${to.left}px, ${to.top}px) scale(0.45)`, opacity: 0 },
        ],
        { duration: 640, easing: "cubic-bezier(0.45, 0, 0.2, 1)" },
      )
      .finished.then(pop, () => undefined)
      .finally(() => ghost.remove())
  }
  // Called once the app has been sent to the new session.
  return () => requestAnimationFrame(find)
}

/**
 * A list that rearranges as it is filtered: rows that stay slide to their new
 * place instead of jumping, and rows that appear fade in. Rows are known by
 * their `data-flip-key`, since a filtered list often builds new elements for
 * the same entries. Returns the cleanup.
 */
export function flipList(root: HTMLElement) {
  const place = (row: HTMLElement) =>
    row.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
  const measure = () =>
    new Map([...root.querySelectorAll<HTMLElement>("[data-flip-key]")].map((row) => [row.dataset.flipKey!, place(row)]))
  let last = measure()
  let queued = false
  const observer = new MutationObserver(() => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      const level = motionLevel()
      const before = last
      last = measure()
      if (level === "none" || before.size === 0) return
      const duration = level === "lite" ? 160 : 280
      for (const row of root.querySelectorAll<HTMLElement>("[data-flip-key]")) {
        const was = before.get(row.dataset.flipKey!)
        const now = last.get(row.dataset.flipKey!)
        if (now === undefined) continue
        if (was === undefined) {
          row.animate(
            [
              { opacity: 0, transform: "scale(0.97)" },
              { opacity: 1, transform: "none" },
            ],
            {
              duration,
              easing: EASE.out,
            },
          )
          continue
        }
        if (Math.abs(was - now) < 1) continue
        row.animate([{ transform: `translateY(${was - now}px)` }, { transform: "none" }], {
          duration,
          easing: level === "lite" ? EASE.out : "cubic-bezier(0.34, 1.18, 0.64, 1)",
        })
      }
    })
  })
  observer.observe(root, { subtree: true, childList: true })
  return () => observer.disconnect()
}

const LIVE_TEXT = '[data-scope-live] [data-component="text-part"] [data-component="markdown"]'

// One front for the whole app: every timeline adds to it, and the three
// highlights it paints are registered once.
const front = {
  buckets: undefined as Highlight[] | undefined,
  chunks: [] as { range: Range; at: number }[],
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
}

function coolFront() {
  front.timer = undefined
  const now = performance.now()
  // Lite mode cools the ink faster; the steps are the same.
  const step = motionLevel() === "lite" ? 160 : 280
  front.chunks = front.chunks.filter((chunk) => now - chunk.at < step * 3)
  front.buckets?.forEach((highlight) => highlight.clear())
  for (const chunk of front.chunks) front.buckets?.[Math.min(2, Math.floor((now - chunk.at) / step))].add(chunk.range)
  if (front.chunks.length) front.timer = setTimeout(coolFront, step / 2)
}

/**
 * The writing front of a live answer: the words that just arrived start in the
 * space's ink and cool to the text color, so in a long answer the eye finds
 * where the agent is writing. Painted with CSS highlights over the rendered
 * text, so the markdown renderer never knows. Returns the cleanup.
 */
export function writingFront(root: HTMLElement) {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return () => {}
  front.buckets ??= ["writing-front-0", "writing-front-1", "writing-front-2"].map((name) => {
    const highlight = new Highlight()
    CSS.highlights.set(name, highlight)
    return highlight
  })
  const lengths = new WeakMap<Element, number>()

  const observer = new MutationObserver((records) => {
    if (motionLevel() === "none") return
    const touched = new Set(
      records.flatMap((record) => {
        const node = record.target instanceof Element ? record.target : record.target.parentElement
        const markdown = node?.closest(LIVE_TEXT)
        return markdown ? [markdown] : []
      }),
    )
    for (const markdown of touched) {
      const length = markdown.textContent?.length ?? 0
      const before = lengths.get(markdown)
      lengths.set(markdown, length)
      // The first render of a part is not news, and text that shrank was rewritten.
      if (before === undefined || length <= before) continue
      const range = tail(markdown, length - before)
      if (range) front.chunks.push({ range, at: performance.now() })
    }
    if (front.chunks.length && front.timer === undefined) coolFront()
  })
  observer.observe(root, { subtree: true, childList: true, characterData: true })
  return () => observer.disconnect()
}

/** A range over the last `count` characters of an element's text. */
function tail(root: Element, count: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  const last = nodes.at(-1)
  if (!last) return
  const range = document.createRange()
  range.setEnd(last, last.length)
  let left = count
  for (const node of nodes.toReversed()) {
    if (node.length >= left) {
      range.setStart(node, node.length - left)
      return range
    }
    left -= node.length
  }
  range.setStart(nodes[0], 0)
  return range
}
