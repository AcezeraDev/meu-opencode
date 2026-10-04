import { Icon } from "@opencode-ai/ui/icon"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createUsdBrlRate } from "@/components/exchange-rate"
import { useLanguage } from "@/context/language"
import { useServerJson } from "@/utils/server-json"
import "./notebook.css"
import "./week.css"
import { WeekLynx } from "./week-lynx"

type Week = {
  since: number
  sessions: number
  steps: number
  cost: number
  modelMs: number
  toolMs: number
  browserMs: number
  tools: number
  errors: number
  browserActions: number
  notebook: number
  reliable?: { model: string; tools: number; errors: number }
  models: { model: string; steps: number; cost: number; tools: number; errors: number }[]
  topErrors: { message: string; count: number }[]
  topSessions: { id: string; title: string; steps: number; cost: number }[]
}

const DAY = 24 * 60 * 60 * 1000
const SPANS = [7, 30] as const

/**
 * A week of using the agent at a glance: what was worked on, how long the
 * model thought and the browser worked, what it cost in the person's money,
 * which model made the fewest mistakes and which errors came up most.
 */
export function WeekPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const json = useServerJson()
  const [days, setDays] = createSignal<(typeof SPANS)[number]>(7)
  const since = createMemo(() => {
    const start = new Date(Date.now() - days() * DAY)
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  })
  const [week] = createResource(since, (value) => json<Week>("/experimental/usage/week", { since: String(value) }), {
    initialValue: undefined,
  })

  const usdBrl = createUsdBrlRate()
  const money = (dollars: number) => {
    const rate = language.intl().toLowerCase().startsWith("pt") ? usdBrl() : undefined
    const amount = rate ? dollars * rate : dollars
    return new Intl.NumberFormat(language.intl(), {
      style: "currency",
      currency: rate ? "BRL" : "USD",
      minimumFractionDigits: 2,
      // A cent is too coarse for a few cheap steps.
      maximumFractionDigits: amount > 0 && amount < 1 ? 3 : 2,
    }).format(amount)
  }
  const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—")

  return (
    <main class="week-page">
      <header class="notebook-header">
        <button
          class="notebook-back"
          type="button"
          aria-label={language.t("agents.back")}
          onClick={() => navigate("/")}
        >
          <Icon name="arrow-left" />
        </button>
        <div>
          <h1>{language.t("week.title")}</h1>
          <p>{language.t("week.subtitle", { days: days() })}</p>
        </div>
        <div class="week-spans" role="group">
          <For each={SPANS}>
            {(span) => (
              <button type="button" aria-pressed={days() === span} onClick={() => setDays(span)}>
                {language.t("week.span", { days: span })}
              </button>
            )}
          </For>
        </div>
      </header>

      <Show
        when={week.latest}
        fallback={
          <div class="notebook-empty">
            <p>{week.loading ? language.t("week.loading") : language.t("week.empty")}</p>
          </div>
        }
      >
        {(data) => (
          <div class="week-body">
            <WeekLynx week={data()} money={money} />
            <section class="week-tiles">
              <Tile label={language.t("week.sessions")} value={String(data().sessions)} />
              <Tile label={language.t("week.cost")} value={money(data().cost)} />
              <Tile label={language.t("week.model")} value={duration(data().modelMs)} />
              <Tile label={language.t("week.browser")} value={duration(data().browserMs)} />
              <Tile
                label={language.t("week.errors")}
                value={percent(data().errors, data().tools)}
                hint={language.t("week.errorsHint", { errors: data().errors, tools: data().tools })}
              />
              <Tile label={language.t("week.notebook")} value={String(data().notebook)} />
            </section>

            <Show when={data().reliable}>
              {(best) => (
                <p class="week-callout">
                  {language.t("week.reliable", {
                    model: best().model,
                    rate: percent(best().errors, best().tools),
                    tools: best().tools,
                  })}
                </p>
              )}
            </Show>

            <Show when={data().topSessions.length > 0}>
              <section class="week-section">
                <h2>{language.t("week.worked")}</h2>
                <ul class="week-list">
                  <For each={data().topSessions}>
                    {(session) => (
                      <li>
                        <span class="week-list-name">{session.title || language.t("week.untitled")}</span>
                        <span class="week-list-meta">
                          {language.t("week.steps", { count: session.steps })} · {money(session.cost)}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            <Show when={data().models.length > 0}>
              <section class="week-section">
                <h2>{language.t("week.models")}</h2>
                <table class="week-table">
                  <thead>
                    <tr>
                      <th>{language.t("week.column.model")}</th>
                      <th>{language.t("week.column.steps")}</th>
                      <th>{language.t("week.column.cost")}</th>
                      <th>{language.t("week.column.errors")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={data().models}>
                      {(model) => (
                        <tr>
                          <td>{model.model}</td>
                          <td>{model.steps}</td>
                          <td>{money(model.cost)}</td>
                          <td>{percent(model.errors, model.tools)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </section>
            </Show>

            <Show when={data().topErrors.length > 0}>
              <section class="week-section">
                <h2>{language.t("week.topErrors")}</h2>
                <ul class="week-list">
                  <For each={data().topErrors}>
                    {(error) => (
                      <li>
                        <span class="week-list-name week-error">{error.message}</span>
                        <span class="week-list-meta">{language.t("week.times", { count: error.count })}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          </div>
        )}
      </Show>
    </main>
  )
}

function Tile(props: { label: string; value: string; hint?: string }) {
  return (
    <div class="week-tile" title={props.hint}>
      <span class="week-tile-value">{props.value}</span>
      <span class="week-tile-label">{props.label}</span>
    </div>
  )
}

/** "45 s", "3 min", "1 h 05 min". */
function duration(ms: number) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return `${Math.round(ms / 1000)} s`
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`
}
