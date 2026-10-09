/**
 * Lynx Code — in every page.
 *
 * Two small jobs, nothing else: tell the extension when the person presses Esc
 * (it stops the Lynx if she is working in this tab), and hand over the text the
 * person selected when the side panel asks for it. It reads nothing on its own.
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

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || message.type !== "selection") return false
  respond(String(window.getSelection() || "").slice(0, 4000))
  return false
})
