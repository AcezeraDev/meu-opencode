import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { createSignal, Match, onCleanup, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useUpdaterAction } from "./updater-action"
import "./personal-update-button.css"

/**
 * Personal desktop builds keep their update button in the titlebar. Where the
 * code lives it compiles the current code (or waits for the watcher's build);
 * on another PC it downloads the newest published build. Either way it then
 * turns into "Restart".
 */
export function PersonalUpdateButton() {
  const platform = usePlatform()
  const language = useLanguage()
  const updater = useUpdaterAction()
  const state = () => platform.updater?.state()
  const busy = () => ["checking", "downloading", "installing"].includes(state()?.status ?? "")
  // Minutes since the build began, kept current while it runs.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 15_000)
  onCleanup(() => clearInterval(timer))

  /** "Building · interface · 3 min" while a build runs, so a long one plainly moves on. */
  const building = () => {
    const current = state()
    // A build from the checkout has no version yet; a published one being downloaded does.
    if (current?.status === "downloading" && current.version) return language.t("settings.updates.action.downloading")
    if (current?.status !== "downloading" || !current.step) return language.t("settings.updates.action.building")
    const minutes = current.started ? Math.max(0, Math.floor((now() - current.started) / 60_000)) : 0
    return language.t("titlebar.personalUpdate.progress", {
      step: language.t(`titlebar.personalUpdate.step.${current.step}`),
      minutes: String(minutes),
    })
  }

  const label = () => {
    const status = state()?.status
    if (status === "checking") return language.t("settings.updates.action.checking")
    if (status === "downloading") return building()
    if (status === "ready") return language.t("titlebar.personalUpdate.restart")
    if (status === "installing") return language.t("settings.updates.action.installing")
    return language.t("titlebar.update")
  }

  const tooltip = () => {
    const current = state()
    if (current?.status === "ready")
      return language.t("titlebar.personalUpdate.readyTooltip", { version: current.version })
    if (current?.status === "downloading" && current.version)
      return language.t("titlebar.personalUpdate.downloadingTooltip", { version: current.version })
    if (current?.status === "downloading") return language.t("titlebar.personalUpdate.buildingTooltip")
    if (current?.status === "error") return current.message
    return language.t("titlebar.personalUpdate.tooltip")
  }

  return (
    <Show when={platform.updater?.personal && state()?.status !== "disabled"}>
      <TooltipV2 placement="bottom" value={tooltip()}>
        <button
          type="button"
          class="personal-update-button"
          data-status={state()?.status}
          data-expanded={busy() || state()?.status === "ready" ? "" : undefined}
          disabled={busy()}
          aria-busy={busy()}
          aria-label={label()}
          onClick={() => void updater.run()}
        >
          <span class="personal-update-icon" aria-hidden="true">
            <Switch
              fallback={
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M11.5 7A4.5 4.5 0 1 1 10 3.64" stroke="currentColor" stroke-linecap="round" />
                  <path d="M10.5 1.5V4H8" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              }
            >
              <Match when={busy()}>
                <span data-slot="titlebar-update-loader" />
              </Match>
              <Match when={state()?.status === "ready"}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128" stroke="currentColor" />
                </svg>
              </Match>
            </Switch>
          </span>
          <span class="personal-update-label">{label()}</span>
        </button>
      </TooltipV2>
    </Show>
  )
}
