import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import "./scope.css"

export type OverviewMarker = {
  index: number
  kind: "user" | "edit" | "error" | "live"
  label?: string
}

type Placed = OverviewMarker & { ratio: number }

/**
 * The record overview of a long session, like the acquisition bar on top of a scope
 * screen turned on its side: where each prompt, file edit and error sits in the
 * whole conversation, and which slice is on screen. Click to jump.
 */
export function OverviewBar(props: {
  root: () => HTMLElement | undefined
  markers: () => OverviewMarker[]
  /** Start offset of a row and the total height, from the virtualizer's measurements. */
  measure: () => { start: (index: number) => number | undefined; total: number }
  onJump: (index: number) => void
  label: string
}) {
  const [tick, setTick] = createSignal(0)
  const [view, setView] = createSignal({ top: 0, height: 1, overflow: false })
  const [hover, setHover] = createSignal<Placed>()

  createEffect(() => {
    const root = props.root()
    if (!root) return
    let frame: number | undefined
    const update = () => {
      frame = undefined
      const max = root.scrollHeight
      setView({
        top: max > 0 ? root.scrollTop / max : 0,
        height: max > 0 ? Math.min(1, root.clientHeight / max) : 1,
        overflow: max > root.clientHeight * 1.5,
      })
      setTick((value) => value + 1)
    }
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(update)
    }
    root.addEventListener("scroll", schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(root)
    // Row heights settle after they render; a slow refresh keeps markers honest.
    const timer = setInterval(schedule, 1500)
    schedule()
    onCleanup(() => {
      root.removeEventListener("scroll", schedule)
      observer.disconnect()
      clearInterval(timer)
      if (frame !== undefined) cancelAnimationFrame(frame)
    })
  })

  const placed = createMemo<Placed[]>(() => {
    tick()
    const { start, total } = props.measure()
    if (total <= 0) return []
    return props.markers().flatMap((marker) => {
      const offset = start(marker.index)
      return offset === undefined ? [] : [{ ...marker, ratio: Math.min(1, Math.max(0, offset / total)) }]
    })
  })

  const jumpToRatio = (event: MouseEvent & { currentTarget: HTMLElement }) => {
    const root = props.root()
    if (!root) return
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - box.top) / box.height
    root.scrollTo({ top: ratio * root.scrollHeight - root.clientHeight / 2, behavior: "smooth" })
  }

  return (
    <Show when={view().overflow && placed().length > 1}>
      <nav class="scope-overview" aria-label={props.label}>
        <div class="scope-overview-track" onClick={jumpToRatio} aria-hidden="true">
          <span
            class="scope-overview-window"
            style={{ top: `${view().top * 100}%`, height: `${view().height * 100}%` }}
          />
          <For each={placed()}>
            {(marker) => (
              <span
                class="scope-overview-marker"
                data-kind={marker.kind}
                data-chroma={marker.kind === "live" ? "" : undefined}
                style={{ top: `${marker.ratio * 100}%` }}
                onPointerEnter={() => setHover(marker)}
                onPointerLeave={() => setHover(undefined)}
                onClick={(event) => {
                  event.stopPropagation()
                  props.onJump(marker.index)
                }}
              />
            )}
          </For>
        </div>
        <Show when={hover()?.label ? hover() : undefined}>
          {(marker) => (
            <div class="scope-overview-tip" style={{ top: `${marker().ratio * 100}%` }}>
              {marker().label}
            </div>
          )}
        </Show>
      </nav>
    </Show>
  )
}
