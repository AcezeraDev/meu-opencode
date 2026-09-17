import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { authTokenFromCredentials } from "@/utils/server"
import { showToast } from "@/utils/toast"
import "./scope-shell.css"

const REFRESH_MS = 30 * 1000
const WARN_RATIO = 0.8
/** Remembers the day the over-limit toast was shown, so it appears once per day. */
const ALERT_KEY = "opencode.scope.spend-alert"

function startOfToday() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Today's model spend across every session, as a titlebar readout. Past the daily
 * limit (Settings, or right here) it turns amber, then red with a one-time alert.
 */
export function DaySpend() {
  const server = useServer()
  const platform = usePlatform()
  const settings = useSettings()
  const language = useLanguage()
  const [spend, setSpend] = createSignal<{ total: number; messages: number }>()
  const [open, setOpen] = createSignal(false)
  const [anchor, setAnchor] = createSignal({ right: 0, top: 0 })
  let root: HTMLDivElement | undefined
  let panel: HTMLDivElement | undefined

  const load = () => {
    const connection = server.current
    if (!connection || document.visibilityState === "hidden") return
    const url = new URL("/experimental/usage/spend", connection.http.url)
    url.searchParams.set("since", String(startOfToday()))
    const headers: Record<string, string> = {}
    if (connection.http.password)
      headers.Authorization = `Basic ${authTokenFromCredentials({ username: connection.http.username, password: connection.http.password })}`
    void (platform.fetch ?? fetch)(url, { headers })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((value: { total: number; messages: number } | undefined) => {
        if (value && Number.isFinite(value.total)) setSpend(value)
      })
      .catch(() => undefined)
  }

  createEffect(() => {
    void server.current
    load()
    const timer = setInterval(load, REFRESH_MS)
    window.addEventListener("focus", load)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener("focus", load)
    })
  })

  const limit = () => settings.usage.dailyLimit()
  const ratio = () => (limit() > 0 ? (spend()?.total ?? 0) / limit() : 0)
  const level = () => (ratio() >= 1 ? "over" : ratio() >= WARN_RATIO ? "near" : "normal")
  const money = (value: number) =>
    new Intl.NumberFormat(language.intl(), {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: value > 0 && value < 1 ? 3 : 2,
    }).format(value)

  createEffect(() => {
    if (level() !== "over") return
    const today = new Date().toDateString()
    const shown = (() => {
      try {
        return localStorage.getItem(ALERT_KEY)
      } catch {
        return null
      }
    })()
    if (shown === today) return
    try {
      localStorage.setItem(ALERT_KEY, today)
    } catch {
      // Without storage the alert may repeat after a reload; that's acceptable.
    }
    showToast({
      variant: "error",
      title: language.t("scope.spend.over"),
      description: language.t("scope.spend.overDescription", {
        spent: money(spend()?.total ?? 0),
        limit: money(limit()),
      }),
    })
  })

  // The titlebar clips its overflow, so the panel renders in a portal below the readout.
  const toggle = () => {
    const box = root?.getBoundingClientRect()
    if (box) setAnchor({ right: window.innerWidth - box.right, top: box.bottom + 8 })
    setOpen((current) => !current)
  }
  const close = (event: PointerEvent) => {
    const target = event.target as Node
    if (root?.contains(target) || panel?.contains(target)) return
    setOpen(false)
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") setOpen(false)
  }
  document.addEventListener("pointerdown", close)
  document.addEventListener("keydown", escape)
  onCleanup(() => {
    document.removeEventListener("pointerdown", close)
    document.removeEventListener("keydown", escape)
  })

  return (
    <Show when={spend()}>
      {(value) => (
        <div class="day-spend" ref={root} data-level={level()}>
          <button
            type="button"
            class="day-spend-button"
            aria-expanded={open()}
            aria-label={`${language.t("scope.spend.title")}: ${money(value().total)}`}
            onClick={toggle}
          >
            <span class="scope-label">{language.t("scope.spend.today")}</span>
            <span class="scope-readout">{money(value().total)}</span>
          </button>
          <Show when={open()}>
            <Portal>
              <div
                ref={panel}
                class="day-spend-panel"
                data-level={level()}
                role="dialog"
                aria-label={language.t("scope.spend.title")}
                style={{ right: `${anchor().right}px`, top: `${anchor().top}px` }}
              >
                <div class="day-spend-row">
                  <span>{language.t("scope.spend.title")}</span>
                  <span class="scope-readout day-spend-value">{money(value().total)}</span>
                </div>
                <div class="day-spend-row day-spend-row-muted">
                  <span>{language.t("scope.spend.responses")}</span>
                  <span class="scope-readout">{value().messages}</span>
                </div>
                <Show when={limit() > 0}>
                  <div class="day-spend-meter" aria-hidden="true">
                    <span style={{ transform: `scaleX(${Math.min(1, ratio())})` }} />
                  </div>
                </Show>
                <label class="day-spend-limit">
                  <span>{language.t("scope.spend.limit")}</span>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={limit() || ""}
                    placeholder="0"
                    onChange={(event) => settings.usage.setDailyLimit(Number(event.currentTarget.value))}
                  />
                </label>
                <p class="day-spend-hint">{language.t("scope.spend.limitHint")}</p>
              </div>
            </Portal>
          </Show>
        </div>
      )}
    </Show>
  )
}
