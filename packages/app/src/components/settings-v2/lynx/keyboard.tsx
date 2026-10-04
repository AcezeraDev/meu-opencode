import { createMemo, createSignal, For } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { fold } from "./overview"
import "./lynx-settings.css"

const ROWS = [
  ["Esc", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "Backspace"],
  ["Tab", "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P", "["],
  ["Caps", "A", "S", "D", "F", "G", "H", "J", "K", "L", "Ç", "Enter"],
  ["Shift", "Z", "X", "C", "V", "B", "N", "M", ",", ".", "/", "↑"],
  ["Ctrl", "Win", "Alt", "Space", "Alt", "Ctrl", "←", "↓", "→"],
]
const WIDE = new Set(["Backspace", "Tab", "Caps", "Enter", "Shift", "Ctrl", "Win", "Alt"])

/** Turns a printed shortcut part ("Ctrl", "⇧", "Espaço", "k") into the key on the drawing. */
function keyOf(part: string) {
  const value = fold(part.trim())
  if (["ctrl", "control", "⌃", "mod", "cmd", "⌘"].includes(value)) return "Ctrl"
  if (["shift", "⇧"].includes(value)) return "Shift"
  if (["alt", "option", "⌥"].includes(value)) return "Alt"
  if (["space", "espaco", "spacebar"].includes(value)) return "Space"
  if (["enter", "return", "↵"].includes(value)) return "Enter"
  if (["esc", "escape"].includes(value)) return "Esc"
  if (["comma"].includes(value)) return ","
  return part.trim().toUpperCase()
}

/**
 * The shortcuts drawn on a keyboard: pick one from the list and its keys
 * light up together, in the order they are pressed.
 */
export function LynxKeyboard() {
  const language = useLanguage()
  const command = useCommand()
  const shortcuts = createMemo(() => [
    { id: "lynx.global", title: language.t("lynx.set.keys.global"), parts: ["Ctrl", "Shift", language.t("lynx.set.keys.space")] },
    ...command.catalog
      .filter((item) => item.keybind && item.title)
      .slice(0, 14)
      .map((item) => ({ id: item.id, title: item.title, parts: command.keybindParts(item.id) })),
  ])
  const [picked, setPicked] = createSignal("lynx.global")
  const lit = createMemo(() => {
    const current = shortcuts().find((item) => item.id === picked())
    return (current?.parts ?? []).map(keyOf)
  })
  return (
    <section class="lynx-keys">
      <div class="lynx-keyboard" aria-hidden="true">
        <For each={ROWS}>
          {(row) => (
            <div class="lynx-key-row">
              <For each={row}>
                {(key) => (
                  <span
                    class="lynx-key"
                    data-wide={WIDE.has(key) ? "" : undefined}
                    data-space={key === "Space" ? "" : undefined}
                    data-lit={lit().includes(key) ? "" : undefined}
                    style={{ "--o": String(Math.max(0, lit().indexOf(key))) }}
                  >
                    {key === "Space" ? language.t("lynx.set.keys.space") : key}
                  </span>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class="lynx-key-list">
        <For each={shortcuts()}>
          {(item) => (
            <button
              type="button"
              aria-pressed={picked() === item.id}
              onMouseEnter={() => setPicked(item.id)}
              onFocus={() => setPicked(item.id)}
              onClick={() => setPicked(item.id)}
            >
              <span>{item.title}</span>
              <span class="lynx-key-combo">
                <For each={item.parts}>{(part) => <kbd>{part}</kbd>}</For>
              </span>
            </button>
          )}
        </For>
      </div>
    </section>
  )
}
