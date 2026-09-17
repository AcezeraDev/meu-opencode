const ANIMATION = "chroma-cycle"

let installed = false

/**
 * Every element with `data-chroma` runs its own copy of the hue animation, which
 * would put each one on a different hue depending on when it mounted. Pinning all
 * of them to the document timeline's origin makes the whole app show one color.
 */
export function installChromaSync() {
  if (installed || typeof document === "undefined") return
  installed = true
  document.addEventListener("animationstart", (event) => {
    if (event.animationName !== ANIMATION || !(event.target instanceof Element)) return
    align(event.target.getAnimations({ subtree: true }))
  })
  align(document.getAnimations())
}

/** Re-pins running animations after the period changes (a new speed shifts every phase). */
export function realignChroma() {
  if (typeof document === "undefined") return
  align(document.getAnimations())
}

function align(animations: Animation[]) {
  for (const animation of animations) {
    if (!(animation instanceof CSSAnimation) || animation.animationName !== ANIMATION) continue
    if (animation.startTime !== 0) animation.startTime = 0
  }
}
