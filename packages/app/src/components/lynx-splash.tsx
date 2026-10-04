import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import "./lynx-splash.css"

/** Away this long, coming back to the window turns it on again like an old screen. */
const AWAY_MS = 20_000

/**
 * The logo signing its name when the app opens (the _ slides down and
 * stretches under "Lynx Code"), and the window switching back on, from a
 * bright line, after being away for a while.
 */
export function LynxSplash() {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches
  const [open, setOpen] = createSignal(!still)
  const [wake, setWake] = createSignal(false)
  // The first seconds of the app are busy loading and would not paint the
  // movement; it starts once the page has a moment to breathe.
  const [run, setRun] = createSignal(false)
  let hiddenAt = 0
  let timers: ReturnType<typeof setTimeout>[] = []

  const visibility = () => {
    if (document.hidden) {
      hiddenAt = Date.now()
      return
    }
    if (still || !hiddenAt || Date.now() - hiddenAt < AWAY_MS) return
    setWake(true)
    timers.push(setTimeout(() => setWake(false), 650))
  }

  onMount(() => {
    const start = () => {
      setRun(true)
      timers.push(setTimeout(() => setOpen(false), 1950))
    }
    if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 2500 })
    else timers.push(setTimeout(start, 600))
    document.addEventListener("visibilitychange", visibility)
  })
  onCleanup(() => {
    timers.forEach(clearTimeout)
    timers = []
    document.removeEventListener("visibilitychange", visibility)
  })

  return (
    <Portal>
      <Show when={open()}>
        <div class="lynx-splash" data-motion="l" data-run={run() ? "" : undefined} aria-hidden="true" onClick={() => setOpen(false)}>
          <div class="lynx-sign">
            <svg viewBox="0 0 64 64" width="72" height="72">
              <defs>
                <radialGradient id="lynx-splash-grad" cx="0.5" cy="0.38" r="0.65">
                  <stop offset="0" stop-color="#22D3EE" />
                  <stop offset="1" stop-color="#6366F1" />
                </radialGradient>
              </defs>
              <rect width="64" height="64" rx="15" fill="#0B1226" />
              <circle data-motion="l" class="lynx-sign-orb" cx="32" cy="32" r="21" fill="url(#lynx-splash-grad)" />
              <path data-motion="l" class="lynx-sign-gt" d="M22 24 L30 31 L22 38" />
            </svg>
            <span data-motion="l" class="lynx-sign-word">Lynx Code</span>
            <i data-motion="l" class="lynx-sign-line" />
          </div>
        </div>
      </Show>
      <Show when={wake()}>
        <div class="lynx-wake" data-motion="l" aria-hidden="true">
          <i data-motion="l" />
        </div>
      </Show>
    </Portal>
  )
}
