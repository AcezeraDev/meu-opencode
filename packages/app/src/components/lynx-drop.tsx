import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import "./lynx-drop.css"

const COMPOSER = '[data-component="prompt-input-v2"]'
const ACTIONS = ["summarize", "questions", "translate", "notebook"] as const

/**
 * Drop a file anywhere: while dragging, the whole window says "drop it for
 * Lynx"; a file dropped outside the composer is handed to it, and the
 * composer then offers what to do with it, which fills in the message.
 */
export function LynxDrop() {
  const language = useLanguage()
  const [dragging, setDragging] = createSignal(false)
  const [dropped, setDropped] = createSignal<string[]>()
  const [above, setAbove] = createSignal(160)
  let depth = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const hasFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files")
  const composer = () => document.querySelector<HTMLFormElement>(COMPOSER)

  const enter = (event: DragEvent) => {
    if (!hasFiles(event) || !composer()) return
    depth++
    setDragging(true)
  }
  const over = (event: DragEvent) => {
    if (!hasFiles(event) || !composer()) return
    // Allows dropping anywhere, not only on the composer.
    event.preventDefault()
  }
  const leave = (event: DragEvent) => {
    if (!hasFiles(event)) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) setDragging(false)
  }
  const drop = (event: DragEvent) => {
    depth = 0
    setDragging(false)
    const form = composer()
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!form || !files.length) return
    if (!form.contains(event.target as Node)) {
      event.preventDefault()
      event.stopPropagation()
      form.dispatchEvent(new DragEvent("drop", { dataTransfer: event.dataTransfer, bubbles: true, cancelable: true }))
    }
    // Sits just above the composer, which grows when the attachment lands.
    requestAnimationFrame(() => setAbove(innerHeight - form.getBoundingClientRect().top + 10))
    setDropped(files.map((file) => file.name))
    clearTimeout(timer)
    timer = setTimeout(() => setDropped(undefined), 12000)
  }

  const use = (action: (typeof ACTIONS)[number]) => {
    const editor = document.querySelector<HTMLElement>(`${COMPOSER} [contenteditable="true"]`)
    setDropped(undefined)
    if (!editor) return
    editor.focus()
    document.execCommand("insertText", false, language.t(`lynx.drop.prompt.${action}` as never))
  }

  onMount(() => {
    addEventListener("dragenter", enter, true)
    addEventListener("dragover", over, true)
    addEventListener("dragleave", leave, true)
    addEventListener("drop", drop, true)
  })
  onCleanup(() => {
    removeEventListener("dragenter", enter, true)
    removeEventListener("dragover", over, true)
    removeEventListener("dragleave", leave, true)
    removeEventListener("drop", drop, true)
    clearTimeout(timer)
  })

  return (
    <Portal>
      <Show when={dragging()}>
        <div class="lynx-drop" data-motion="l" aria-hidden="true">
          <div class="lynx-drop-ring">
            <b>{language.t("lynx.drop.title")}</b>
            <span>{language.t("lynx.drop.hint")}</span>
          </div>
        </div>
      </Show>
      <Show when={dropped()}>
        {(names) => (
          <div
            class="lynx-drop-actions"
            role="group"
            aria-label={language.t("lynx.drop.actions")}
            data-motion="l"
            style={{ bottom: `${above()}px` }}
          >
            <span>{names().length === 1 ? names()[0] : language.t("lynx.drop.files", { count: names().length })}</span>
            <For each={ACTIONS}>
              {(action, index) => (
                <button type="button" style={{ "--i": String(index()) }} onClick={() => use(action)}>
                  {language.t(`lynx.drop.action.${action}` as never)}
                </button>
              )}
            </For>
            <button type="button" class="lynx-drop-close" aria-label={language.t("common.close")} onClick={() => setDropped(undefined)}>
              ✕
            </button>
          </div>
        )}
      </Show>
    </Portal>
  )
}
