import { createEffect, on } from "solid-js"
import { EASE, motionLevel } from "@/utils/motion"

/**
 * A label that turns over like a station board when its value changes: the
 * old text leaves upwards as the new one comes up from below, so a change
 * (the model in use, say) is noticed even with the eyes elsewhere.
 */
export function FlipText(props: { value: string; class?: string }) {
  let box!: HTMLSpanElement
  let current!: HTMLSpanElement
  createEffect(
    on(
      () => props.value,
      (value, previous) => {
        if (previous === undefined || previous === value) return
        const level = motionLevel()
        if (level === "none") return
        const duration = level === "lite" ? 200 : 380
        const ghost = document.createElement("span")
        ghost.setAttribute("aria-hidden", "true")
        ghost.textContent = previous
        ghost.style.cssText = "position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;"
        box.appendChild(ghost)
        ghost
          .animate(
            [
              { transform: "none", opacity: 1 },
              { transform: "translateY(-100%)", opacity: 0 },
            ],
            { duration, easing: EASE.out },
          )
          .finished.finally(() => ghost.remove())
        // Transforms need a box; the label goes back to plain text so it can truncate again.
        current.style.display = "inline-block"
        current
          .animate(
            [
              { transform: "translateY(100%)", opacity: 0 },
              { transform: "none", opacity: 1 },
            ],
            { duration, easing: level === "lite" ? EASE.out : EASE.spring },
          )
          .finished.finally(() => (current.style.display = ""))
      },
    ),
  )
  return (
    <span ref={box} class={`relative ${props.class ?? ""}`}>
      <span ref={current}>{props.value}</span>
    </span>
  )
}
