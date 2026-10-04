import { createMemo, createResource, For, Show } from "solid-js"
import { createUsdBrlRate } from "@/components/exchange-rate"
import { useLanguage } from "@/context/language"
import { useLynxPrefs } from "@/context/lynx-prefs"
import { useSettings } from "@/context/settings"
import { useServerJson } from "@/utils/server-json"
import "./lynx-settings.css"

const DAY = 24 * 60 * 60 * 1000
const DAYS = 30

/**
 * The month's budget in reais: a slider for the limit, what was spent so far
 * and a bar per day of the last month against the daily share of the budget.
 */
export function LynxBudget() {
  const language = useLanguage()
  const prefs = useLynxPrefs()
  const settings = useSettings()
  const json = useServerJson()
  const rate = createUsdBrlRate()
  const brl = (usd: number) => usd * (rate() ?? 5)
  const money = (reais: number) =>
    new Intl.NumberFormat(language.intl(), { style: "currency", currency: "BRL" }).format(reais)

  // The spend route sums from a moment until now, so each day is the
  // difference between two of those sums.
  const [days] = createResource(
    async () => {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const starts = Array.from({ length: DAYS + 1 }, (_, index) => today.getTime() - (DAYS - index) * DAY)
      const totals = await Promise.all(
        starts.map((since) =>
          json<{ total: number }>("/experimental/usage/spend", { since: String(since) }).then((value) => value?.total ?? 0),
        ),
      )
      return starts.map((start, index) => ({
        start,
        usd: index < starts.length - 1 ? Math.max(0, totals[index] - totals[index + 1]) : totals[index],
      }))
    },
    { initialValue: [] },
  )
  const month = createMemo(() => {
    const first = new Date()
    first.setDate(1)
    first.setHours(0, 0, 0, 0)
    return brl(days.latest.filter((day) => day.start >= first.getTime()).reduce((sum, day) => sum + day.usd, 0))
  })
  const budget = () => prefs.get("monthlyBudget")
  const share = () => (budget() ? budget() / 30 : 0)
  const peak = () => Math.max(share(), ...days.latest.map((day) => brl(day.usd)), 0.01)
  const used = () => (budget() ? Math.min(1, month() / budget()) : 0)

  return (
    <div class="lynx-set">
      <header class="lynx-set-head">
        <h2>{language.t("lynx.set.tab.budget")}</h2>
        <p>{language.t("lynx.set.budget.lead")}</p>
      </header>
      <section class="lynx-budget-top">
        <div>
          <span class="lynx-set-label">{language.t("lynx.set.budget.limit")}</span>
          <b class="lynx-big">{budget() ? money(budget()) : language.t("lynx.set.budget.none")}</b>
        </div>
        <div class="lynx-budget-spent">
          <span class="lynx-set-label">{language.t("lynx.set.budget.spent")}</span>
          <b class="lynx-big lynx-cyan">{money(month())}</b>
        </div>
      </section>
      <input
        class="lynx-range"
        type="range"
        min="0"
        max="300"
        step="5"
        value={budget()}
        aria-label={language.t("lynx.set.budget.limit")}
        onInput={(event) => prefs.set("monthlyBudget", Number(event.currentTarget.value))}
      />
      <Show when={budget()}>
        <div class="lynx-budget-bar" data-warn={used() > 0.8 ? "" : undefined}>
          <i style={{ width: `${used() * 100}%` }} />
        </div>
      </Show>
      <section>
        <span class="lynx-set-label">{language.t("lynx.set.budget.days")}</span>
        <div class="lynx-chart">
          <For each={days.latest}>
            {(day, index) => (
              <i
                title={`${new Date(day.start).toLocaleDateString(language.intl())} · ${money(brl(day.usd))}`}
                data-over={share() && brl(day.usd) > share() ? "" : undefined}
                style={{ height: `${Math.max(2, (brl(day.usd) / peak()) * 100)}%`, "animation-delay": `${index() * 20}ms` }}
              />
            )}
          </For>
          <Show when={share()}>
            <span class="lynx-chart-limit" style={{ bottom: `${(share() / peak()) * 100}%` }}>
              {language.t("lynx.set.budget.share", { value: money(share()) })}
            </span>
          </Show>
        </div>
      </section>
      <section class="lynx-set-row">
        <div>
          <b>{language.t("lynx.set.budget.daily")}</b>
          <small>{language.t("lynx.set.budget.daily.hint")}</small>
        </div>
        <input
          class="lynx-number"
          type="number"
          min="0"
          step="0.5"
          value={Number(brl(settings.usage.dailyLimit()).toFixed(2))}
          onChange={(event) => settings.usage.setDailyLimit(Number(event.currentTarget.value) / (rate() ?? 5))}
        />
      </section>
    </div>
  )
}
