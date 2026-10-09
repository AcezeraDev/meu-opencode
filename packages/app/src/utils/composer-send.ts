/**
 * Types `text` into the composer of the conversation on screen and sends it, as
 * if the person had. For answers that come from outside the composer: the
 * desktop's corner note and the browser extension's side panel.
 *
 * Returns false when no conversation's composer is open.
 */
export function sendToOpenComposer(text: string) {
  const form = document.querySelector<HTMLFormElement>('[data-component="prompt-input-v2"]')
  const editor = form?.querySelector<HTMLElement>('[contenteditable="true"]')
  if (!form || !editor) return false
  editor.focus()
  document.execCommand("insertText", false, text)
  requestAnimationFrame(() => form.requestSubmit())
  return true
}
