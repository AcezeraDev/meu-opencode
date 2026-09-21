import { Icon } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import "./session-mode.css"

/**
 * Session layouts are presets over the panels the session page already has
 * (review, file tree, terminal, chat width). They never introduce parallel state
 * for those panels, so switching modes can't desync anything.
 */
export const SESSION_MODES = [
  { id: "conversation", icon: "menu", key: "session.mode.conversation" },
  { id: "trail", icon: "status", key: "session.mode.trail" },
  { id: "cockpit", icon: "sidebar-right", key: "session.mode.cockpit" },
  { id: "split", icon: "split", key: "session.mode.split" },
  { id: "review", icon: "review", key: "session.mode.review" },
] as const

export type SessionMode = (typeof SESSION_MODES)[number]["id"]

export function createSessionModeState() {
  const [store, setStore] = persisted(
    Persist.global("session.mode"),
    createStore({ mode: "conversation" as SessionMode }),
  )
  return {
    mode: () => store.mode,
    set: (mode: SessionMode) => setStore("mode", mode),
  }
}

export function SessionModeSwitcher(props: { mode: SessionMode; onChange: (mode: SessionMode) => void }) {
  const language = useLanguage()

  return (
    <div class="session-mode-switcher" role="radiogroup" aria-label={language.t("session.mode.label")}>
      <For each={SESSION_MODES}>
        {(item) => (
          <TooltipV2 placement="bottom" value={language.t(item.key)}>
            <button
              type="button"
              role="radio"
              class="session-mode-option"
              aria-checked={props.mode === item.id}
              aria-label={language.t(item.key)}
              data-active={props.mode === item.id ? "" : undefined}
              data-chroma={props.mode === item.id ? "" : undefined}
              onClick={() => props.onChange(item.id)}
            >
              <Icon name={item.icon} size="small" />
              <Show when={props.mode === item.id}>
                <span class="session-mode-option-label" aria-hidden="true">
                  {language.t(item.key)}
                </span>
              </Show>
            </button>
          </TooltipV2>
        )}
      </For>
    </div>
  )
}
