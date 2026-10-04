import { createSignal, onCleanup, type ParentProps } from "solid-js"
import { useLanguage } from "@/context/language"
import { browserPane } from "./pane-state"
import "./browser-float.css"

type Box = { x: number; y: number; width: number; height: number }

const KEY = "lynx.browser.float.box"
const MIN = { width: 320, height: 240 }

function initial(): Box {
  const fallback = { width: 460, height: 340, x: innerWidth - 476, y: innerHeight - 470 }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Box | null
    if (saved && saved.width >= MIN.width) return clamp(saved)
  } catch {}
  return clamp(fallback)
}

function clamp(box: Box): Box {
  const width = Math.min(Math.max(box.width, MIN.width), innerWidth - 16)
  const height = Math.min(Math.max(box.height, MIN.height), innerHeight - 16)
  return {
    width,
    height,
    x: Math.min(Math.max(8, box.x), innerWidth - width - 8),
    y: Math.min(Math.max(8, box.y), innerHeight - height - 8),
  }
}

/**
 * The browser pane as a picture-in-picture window over the conversation:
 * dragged by its grip, resized from the corner, docked back with one click.
 */
export function BrowserFloat(props: ParentProps) {
  const language = useLanguage()
  const [box, setBox] = createSignal(initial())

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(box()))
    } catch {}
  }

  const track = (event: PointerEvent, mode: "move" | "size") => {
    event.preventDefault()
    const start = { x: event.clientX, y: event.clientY, box: box() }
    const move = (next: PointerEvent) => {
      const dx = next.clientX - start.x
      const dy = next.clientY - start.y
      setBox(
        clamp(
          mode === "move"
            ? { ...start.box, x: start.box.x + dx, y: start.box.y + dy }
            : { ...start.box, width: start.box.width + dx, height: start.box.height + dy },
        ),
      )
    }
    const up = () => {
      removeEventListener("pointermove", move)
      removeEventListener("pointerup", up)
      save()
    }
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
  }

  const refit = () => setBox(clamp(box()))
  addEventListener("resize", refit)
  onCleanup(() => removeEventListener("resize", refit))

  return (
    <div
      class="lynx-float"
      data-motion="l"
      style={{
        left: `${box().x}px`,
        top: `${box().y}px`,
        width: `${box().width}px`,
        height: `${box().height}px`,
      }}
    >
      <div class="lynx-float-grip" onPointerDown={(event) => track(event, "move")}>
        <span class="lynx-float-dots" aria-hidden="true" />
        <span>{language.t("lynx.browser.float")}</span>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => browserPane.setFloating(false)}
        >
          {language.t("lynx.browser.dock")}
        </button>
      </div>
      <div class="lynx-float-body">{props.children}</div>
      <span
        class="lynx-float-size"
        aria-label={language.t("lynx.browser.resize")}
        onPointerDown={(event) => track(event, "size")}
      />
    </div>
  )
}
