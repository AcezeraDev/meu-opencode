import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import "./scope-shell.css"

/** Holding Ctrl this long, without pressing anything else, opens the shortcut sheet. */
const HOLD_MS = 650
const SUGGESTED_PREFIX = "suggested."

/**
 * The scope's softkey labels: hold Ctrl and every keyboard shortcut available right
 * now appears, grouped by area. Releasing Ctrl, pressing another key or using the
 * mouse closes it, so ordinary shortcuts like Ctrl+C never flash it.
 */
export function Softkeys() {
  const command = useCommand()
  const language = useLanguage()
  const [visible, setVisible] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    setVisible(false)
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Control" && !event.repeat && !event.shiftKey && !event.altKey && !event.metaKey) {
      cancel()
      timer = setTimeout(() => setVisible(true), HOLD_MS)
      return
    }
    if (event.key !== "Control") cancel()
  }
  const keyup = (event: KeyboardEvent) => {
    if (event.key === "Control") cancel()
  }

  window.addEventListener("keydown", keydown, true)
  window.addEventListener("keyup", keyup, true)
  window.addEventListener("pointerdown", cancel, true)
  window.addEventListener("wheel", cancel, { capture: true, passive: true })
  window.addEventListener("blur", cancel)
  onCleanup(() => {
    cancel()
    window.removeEventListener("keydown", keydown, true)
    window.removeEventListener("keyup", keyup, true)
    window.removeEventListener("pointerdown", cancel, true)
    window.removeEventListener("wheel", cancel, true)
    window.removeEventListener("blur", cancel)
  })

  const groups = createMemo(() => {
    if (!visible()) return []
    const seen = new Set<string>()
    const byCategory = new Map<string, { id: string; title: string; keys: string[] }[]>()
    for (const option of command.options) {
      const id = option.id.startsWith(SUGGESTED_PREFIX) ? option.id.slice(SUGGESTED_PREFIX.length) : option.id
      if (seen.has(id) || option.disabled || option.hidden || !option.title || !option.keybind) continue
      const keys = command.keybindParts(id)
      if (keys.length === 0) continue
      seen.add(id)
      const category = option.category ?? language.t("softkeys.other")
      byCategory.set(category, [...(byCategory.get(category) ?? []), { id, title: option.title, keys }])
    }
    return [...byCategory.entries()]
      .filter(([category]) => category !== language.t("command.category.suggested"))
      .map(([category, items]) => ({ category, items }))
  })

  return (
    <Show when={visible() && groups().length > 0}>
      <div class="softkeys" role="dialog" aria-label={language.t("softkeys.title")}>
        <div class="softkeys-panel">
          <div class="softkeys-head">
            <span class="softkeys-led" data-chroma aria-hidden="true" />
            <span class="scope-label">{language.t("softkeys.title")}</span>
            <span class="softkeys-hint">{language.t("softkeys.hint")}</span>
          </div>
          <div class="softkeys-grid">
            <For each={groups()}>
              {(group, groupIndex) => (
                <section class="softkeys-group" style={{ "--i": groupIndex() }}>
                  <h3 class="scope-label">{group.category}</h3>
                  <For each={group.items}>
                    {(item) => (
                      <div class="softkeys-row">
                        <span class="softkeys-title">{item.title}</span>
                        <KeybindV2 keys={item.keys} variant="neutral" />
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}
