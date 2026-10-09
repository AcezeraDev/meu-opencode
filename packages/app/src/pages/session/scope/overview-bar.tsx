import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import "./scope.css"

export type OverviewMarker = {
  index: number
  kind: "user" | "edit" | "error" | "live"
  label?: string
}

/** One row of the conversation drawn in the minimap: what it is, at its real height. */
export type OverviewBlock = {
  index: number
  kind: "user" | "text" | "tool" | "error"
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
  /** Start offset and height of a row and the total height, from the virtualizer's measurements. */
  measure: () => {
    start: (index: number) => number | undefined
    size?: (index: number) => number | undefined
    total: number
  }
  /** Every row, for the minimap; without it the bar shows only the markers. */
  blocks?: () => OverviewBlock[]
  onJump: (index: number) => void
  label: string
}) {
  const [tick, setTick] = createSignal(0)
  const [view, setView] = createSignal({ top: 0, height: 1, overflow: false })
  const [hover, setHover] = createSignal<Placed>()
  // Markers already there when the bar appears are history; one that shows up
  // later is something that just happened, and lands with a beat. Markers are
  // rebuilt on every refresh, so a marker is known by its row and kind.
  const known = new Set<string>()
  const [settled, setSettled] = createSignal(false)
  const settle = setTimeout(() => setSettled(true), 1500)
  onCleanup(() => clearTimeout(settle))
  const fresh = (marker: Placed) => {
    const key = `${marker.index}:${marker.kind}`
    if (known.has(key)) return false
    known.add(key)
    return settled() && marker.kind !== "live"
  }

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

  const drawn = createMemo(() => {
    tick()
    const blocks = props.blocks?.()
    if (!blocks) return []
    const { start, size, total } = props.measure()
    if (total <= 0) return []
    return blocks.flatMap((block) => {
      const offset = start(block.index)
      if (offset === undefined) return []
      const height = size?.(block.index) ?? 0
      return [{ ...block, top: offset / total, height: height / total }]
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
    <Show when={view().overflow && (placed().length > 1 || drawn().length > 1)}>
      <nav class="scope-overview" data-minimap={props.blocks ? "" : undefined} aria-label={props.label}>
        <div class="scope-overview-track" onClick={jumpToRatio} aria-hidden="true">
          <For each={drawn()}>
            {(block) => (
              <span
                class="scope-minimap-block"
                data-kind={block.kind}
                style={{ top: `${block.top * 100}%`, height: `${block.height * 100}%` }}
              />
            )}
          </For>
          <span
            class="scope-overview-window"
            style={{ top: `${view().top * 100}%`, height: `${view().height * 100}%` }}
          />
          <For each={placed()}>
            {(marker) => (
              <span
                class="scope-overview-marker"
                data-kind={marker.kind}
                data-fresh={fresh(marker) ? "" : undefined}
                data-motion="l"
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
