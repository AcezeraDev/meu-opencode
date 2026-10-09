/**
 * Lynx Code — in every page.
 *
 * Small jobs, each only when asked: tell the extension when the person presses
 * Esc (it stops the Lynx if she is working in this tab), hand over the text the
 * person selected or the page's readable text, and let the person drag a box on
 * the page for a screenshot of just that area. It reads nothing on its own.
 */

addEventListener(
  "keydown",
  (event) => {
    // Only a key the person pressed; the extension also ignores the Esc the Lynx
    // herself sends through the debugger, which arrives trusted too.
    if (event.key !== "Escape" || !event.isTrusted || event.repeat) return
    chrome.runtime.sendMessage({ type: "esc" }).catch(() => {})
  },
  true,
)

/** The page as text: its main content when it marks one, without menus and scripts. */
const TEXT_LIMIT = 24000

function pageText() {
  const root = document.querySelector("article, main, [role=main], #region-main, .course-content") || document.body
  if (!root) return ""
  const text = (root.innerText || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n[…página cortada]` : text
}

/**
 * Shows a dimmed layer to drag a box on. Resolves the box in CSS pixels plus
 * the device pixel ratio, or null on Esc or a click without a drag. The layer is
 * gone (and painted away) before it resolves, so the screenshot does not show it.
 */
function crop() {
  return new Promise((resolve) => {
    const layer = document.createElement("div")
    layer.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.35);user-select:none;"
    const box = document.createElement("div")
    box.style.cssText =
      "position:fixed;border:2px solid #ff6b5b;background:rgba(255,107,91,0.12);box-shadow:0 0 0 9999px rgba(0,0,0,0.35);display:none;"
    const hint = document.createElement("div")
    hint.textContent = "Arraste para escolher a área do print · Esc cancela"
    hint.style.cssText =
      "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#161616;color:#f2f2f2;font:14px system-ui,sans-serif;padding:8px 14px;border-radius:10px;border:1px solid #ff6b5b;"
    layer.append(box, hint)
    document.documentElement.append(layer)
    let start
    const finish = (value) => {
      removeEventListener("keydown", onKey, true)
      layer.remove()
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(value)))
    }
    const onKey = (event) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      finish(null)
    }
    addEventListener("keydown", onKey, true)
    layer.addEventListener("pointerdown", (event) => {
      start = { x: event.clientX, y: event.clientY }
      try {
        layer.setPointerCapture(event.pointerId)
      } catch {
        // A pointer the page made up cannot be captured; the drag still works without it.
      }
      layer.style.background = "transparent"
      hint.remove()
    })
    layer.addEventListener("pointermove", (event) => {
      if (!start) return
      const x = Math.min(start.x, event.clientX)
      const y = Math.min(start.y, event.clientY)
      Object.assign(box.style, {
        display: "block",
        left: `${x}px`,
        top: `${y}px`,
        width: `${Math.abs(event.clientX - start.x)}px`,
        height: `${Math.abs(event.clientY - start.y)}px`,
      })
    })
    layer.addEventListener("pointerup", (event) => {
      if (!start) return
      const rect = {
        x: Math.min(start.x, event.clientX),
        y: Math.min(start.y, event.clientY),
        width: Math.abs(event.clientX - start.x),
        height: Math.abs(event.clientY - start.y),
        dpr: devicePixelRatio,
      }
      finish(rect.width < 8 || rect.height < 8 ? null : rect)
    })
  })
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message) return false
  if (message.type === "selection") {
    respond(String(window.getSelection() || "").slice(0, 4000))
    return false
  }
  // Only the top frame answers: frames would each send their own piece.
  if (window !== window.top) return false
  if (message.type === "page-text") {
    respond({ text: pageText() })
    return false
  }
  if (message.type === "crop") {
    void crop().then(respond)
    return true
  }
  return false
})
