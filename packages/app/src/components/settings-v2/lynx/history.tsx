import { DateTime } from "luxon"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSettingsHistory, type Change } from "@/context/lynx-history"
import "./lynx-settings.css"

function show(value: unknown) {
  if (value === undefined || value === null) return "—"
  if (typeof value === "boolean") return value ? "✓" : "✕"
  if (typeof value === "object") return JSON.stringify(value).slice(0, 40)
  return String(value)
}

/** What changed in the settings, newest first, each with Undo. */
export function LynxHistory() {
  const language = useLanguage()
  const history = useSettingsHistory()
  const name = (change: Change) => {
    const key = `lynx.set.history.key.${change.path.at(-1)}`
    const known = language.t(key as never)
    return known === key ? change.path.join(" › ") : known
  }
  return (
    <div class="lynx-set">
      <header class="lynx-set-head">
        <h2>{language.t("lynx.set.tab.history")}</h2>
        <p>{language.t("lynx.set.history.lead")}</p>
      </header>
      <Show when={history.list().length} fallback={<p class="lynx-set-mute">{language.t("lynx.set.history.empty")}</p>}>
        <ol class="lynx-history">
          <For each={history.list()}>
            {(change) => (
              <li>
                <span class="lynx-history-when">
                  {DateTime.fromMillis(change.at).setLocale(language.intl()).toRelative()}
                </span>
                <div>
                  <b>{name(change)}</b>
                  <small>
                    {show(change.from)} → {show(change.to)}
                  </small>
                </div>
                <button type="button" class="lynx-set-btn lynx-set-btn-ghost" onClick={() => history.undo(change)}>
                  ↶ {language.t("lynx.set.undo")}
                </button>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  )
}
