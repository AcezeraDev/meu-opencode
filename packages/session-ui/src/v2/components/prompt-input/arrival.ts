/**
 * How an attachment arrives in the composer, so it is plain what just came in
 * and where it went. A long paste shows its first lines for a moment and folds
 * into its `texto-colado.md` card; a dropped file falls from where it was let
 * go and lands on its card with a small squash. Anything else (a file picked
 * in the dialog, a draft restored) just appears.
 *
 * The paste and drop handlers say what is coming; the card, when it mounts,
 * plays the arrival that matches. Reduced motion skips it; Lite mode keeps it
 * short, since it is one movement per arrival.
 */

type Expected =
  | { kind: "paste"; text: string; from: DOMRect; at: number }
  | { kind: "drop"; x: number; y: number; at: number; landed: number }

let expected: Expected | undefined

const OUT = "cubic-bezier(0.2, 0, 0, 1)"
const SPRING = "cubic-bezier(0.34, 1.32, 0.64, 1)"

function level() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "none"
  return document.documentElement.hasAttribute("data-lite") ? "lite" : "full"
}

export function expectPaste(text: string, from: DOMRect | undefined) {
  if (from) expected = { kind: "paste", text, from, at: performance.now() }
}

export function expectDrop(x: number, y: number) {
  expected = { kind: "drop", x, y, at: performance.now(), landed: 0 }
}

/** Plays the arrival a new attachment card is owed, if any. */
export function arrive(card: HTMLElement) {
  const next = expected
  if (!next || performance.now() - next.at > 2000) return
  const motion = level()
  if (motion === "none") return
  // Measured once the card has its place in the row.
  requestAnimationFrame(() => {
    const to = card.getBoundingClientRect()
    if (next.kind === "paste") {
      expected = undefined
      fold(next.text, next.from, to, motion)
      card.animate(
        [
          { transform: "scale(0.7)", opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        {
          duration: motion === "lite" ? 240 : 420,
          delay: motion === "lite" ? 0 : 260,
          easing: motion === "lite" ? OUT : SPRING,
          fill: "backwards",
        },
      )
      return
    }
    // Several files dropped together land one after the other.
    const delay = next.landed++ * 70
    const dx = next.x - (to.left + to.width / 2)
    const dy = next.y - (to.top + to.height / 2)
    card.animate(
      motion === "lite"
        ? [
            { transform: `translate(${dx * 0.2}px, ${dy * 0.2}px)`, opacity: 0 },
            { transform: "none", opacity: 1 },
          ]
        : [
            { transform: `translate(${dx}px, ${dy}px) rotate(-8deg) scale(0.9)`, opacity: 0.3 },
            { transform: "translate(0, 0) rotate(0) scale(1.08, 0.9)", opacity: 1, offset: 0.72 },
            { transform: "scale(0.97, 1.04)", offset: 0.86 },
            { transform: "none", opacity: 1 },
          ],
      {
        duration: motion === "lite" ? 240 : 560,
        delay,
        easing: motion === "lite" ? OUT : "cubic-bezier(0.5, 0, 0.75, 0)",
        fill: "backwards",
      },
    )
  })
}

/** The first lines of a long paste, shown over the editor, folding into the card. */
function fold(text: string, from: DOMRect, to: DOMRect, motion: "lite" | "full") {
  if (motion === "lite") return
  const preview = document.createElement("div")
  preview.setAttribute("aria-hidden", "true")
  preview.textContent = text.split("\n").slice(0, 9).join("\n")
  preview.style.cssText =
    `position:fixed;left:${from.left}px;top:${from.top}px;width:${from.width}px;max-height:${Math.max(60, from.height)}px;` +
    "z-index:60;pointer-events:none;overflow:hidden;white-space:pre;padding:6px 10px;border-radius:10px;" +
    "font:11px/1.45 var(--font-family-mono, monospace);color:var(--v2-text-text-muted);" +
    "background:var(--v2-background-bg-layer-02);box-shadow:inset 0 0 0 1px var(--v2-border-border-base);" +
    "transform-origin:top left;"
  document.body.appendChild(preview)
  const scaleX = Math.max(0.1, to.width / from.width)
  const scaleY = Math.max(0.1, to.height / Math.max(60, from.height))
  preview
    .animate(
      [
        { opacity: 0, transform: "translate(0, 6px)" },
        { opacity: 1, transform: "none", offset: 0.25 },
        { opacity: 1, transform: "none", offset: 0.45 },
        {
          opacity: 0,
          transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${scaleX}, ${scaleY})`,
        },
      ],
      { duration: 720, easing: OUT },
    )
    .finished.finally(() => preview.remove())
}
