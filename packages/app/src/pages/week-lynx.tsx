import { DateTime } from "luxon"
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useLynxPrefs } from "@/context/lynx-prefs"
import { useServer } from "@/context/server"
import { useServerJson } from "@/utils/server-json"
import "./week-lynx.css"

export type WeekData = {
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
  models: { model: string; steps: number; cost: number; tools: number; errors: number }[]
  topErrors: { message: string; count: number }[]
  topSessions: { id: string; title: string; steps: number; cost: number }[]
}

const DAY = 24 * 60 * 60 * 1000

function startOfDay(offset: number) {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime() - offset * DAY
}

function hours(ms: number) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`
}

/**
 * The Lynx Code week: a story of the week, a bar per day, this week against
 * the last, where the money went, the month as a calendar, small achievements,
 * the week's pictures, a letter from Lynx and a plan for next week.
 */
export function WeekLynx(props: { week: WeekData; money: (dollars: number) => string }) {
  const json = useServerJson()
  const language = useLanguage()

  // Each day is the difference between two "since" summaries, the route's only shape.
  const [days] = createResource(
    async () => {
      const starts = Array.from({ length: 7 }, (_, index) => startOfDay(6 - index))
      const sums = await Promise.all(starts.map((since) => json<WeekData>("/experimental/usage/week", { since: String(since) })))
      return sums.map((sum, index) => {
        const next = sums[index + 1]
        const take = (key: "sessions" | "cost" | "modelMs" | "toolMs") =>
          Math.max(0, (sum?.[key] ?? 0) - (next?.[key] ?? 0))
        return { start: starts[index], sessions: take("sessions"), cost: take("cost"), ms: take("modelMs") + take("toolMs") }
      })
    },
    { initialValue: [] },
  )
  const [previous] = createResource(
    async () => {
      const [two, one] = await Promise.all([
        json<WeekData>("/experimental/usage/week", { since: String(startOfDay(13)) }),
        json<WeekData>("/experimental/usage/week", { since: String(startOfDay(6)) }),
      ])
      if (!two || !one) return undefined
      return {
        sessions: two.sessions - one.sessions,
        cost: two.cost - one.cost,
        ms: two.modelMs + two.toolMs - one.modelMs - one.toolMs,
        errors: two.errors - one.errors,
        tools: two.tools - one.tools,
      }
    },
    { initialValue: undefined },
  )

  return (
    <div class="lynx-week">
      <Story week={props.week} money={props.money} />
      <div class="lynx-week-grid">
        <Bars days={days.latest} />
        <Compare week={props.week} previous={previous.latest} money={props.money} />
        <Money week={props.week} money={props.money} />
        <Calendar />
        <Badges week={props.week} />
        <Letter week={props.week} money={props.money} />
        <Photos week={props.week} />
        <Plan week={props.week} />
      </div>
      <p class="lynx-week-foot">{language.t("lynx.week.foot")}</p>
    </div>
  )
}

/* ---------- Retrospective, as stories ---------- */

function Story(props: { week: WeekData; money: (dollars: number) => string }) {
  const language = useLanguage()
  const [at, setAt] = createSignal(0)
  // "nano-gpt/qwen/qwen3.7-flash:thinking" reads as "qwen3.7-flash".
  const favorite = () =>
    [...props.week.models].sort((a, b) => b.steps - a.steps)[0]?.model.split("/").pop()?.replace(/:.*$/, "")
  const slides = () => [
    { lead: language.t("lynx.week.story.sessions"), big: String(props.week.sessions), tail: language.t("lynx.week.story.sessions.tail") },
    { lead: language.t("lynx.week.story.browser"), big: hours(props.week.browserMs), tail: language.t("lynx.week.story.browser.tail", { count: props.week.browserActions }) },
    { lead: language.t("lynx.week.story.model"), big: favorite() ?? "—", tail: language.t("lynx.week.story.model.tail") },
    { lead: language.t("lynx.week.story.cost"), big: props.money(props.week.cost), tail: language.t("lynx.week.story.cost.tail") },
  ]
  const timer = setInterval(() => setAt((value) => (value + 1) % slides().length), 3600)
  onCleanup(() => clearInterval(timer))
  return (
    <section class="lynx-story" onClick={() => setAt((value) => (value + 1) % slides().length)}>
      <div class="lynx-story-bars">
        <For each={slides()}>
          {(_, index) => (
            <i>
              <b data-state={index() < at() ? "done" : index() === at() ? "now" : undefined} />
            </i>
          )}
        </For>
      </div>
      <Show when={slides()[at()]} keyed>
        {(slide) => (
          <div class="lynx-story-slide" data-motion="l">
            <span>{slide.lead}</span>
            <b>{slide.big}</b>
            <span>{slide.tail}</span>
          </div>
        )}
      </Show>
    </section>
  )
}

/* ---------- A bar per day ---------- */

function Bars(props: { days: { start: number; sessions: number; cost: number; ms: number }[] }) {
  const language = useLanguage()
  const peak = () => Math.max(1, ...props.days.map((day) => day.ms))
  const top = () => props.days.reduce((best, day) => (day.ms > (best?.ms ?? -1) ? day : best), props.days[0])
  return (
    <section class="lynx-card lynx-wide">
      <h2>{language.t("lynx.week.bars")}</h2>
      <div class="lynx-bars">
        <For each={props.days}>
          {(day, index) => (
            <div class="lynx-bar-col">
              <div
                class="lynx-bar"
                data-peak={day === top() && day.ms > 0 ? "" : undefined}
                style={{ height: `${Math.max(3, (day.ms / peak()) * 100)}%`, "animation-delay": `${index() * 70}ms` }}
              >
                <Show when={day === top() && day.ms > 0}>
                  <span class="lynx-bar-tag">{hours(day.ms)}</span>
                </Show>
              </div>
              <span>{DateTime.fromMillis(day.start).setLocale(language.intl()).toFormat("ccc")}</span>
            </div>
          )}
        </For>
      </div>
    </section>
  )
}

/* ---------- This week against the last ---------- */

function Compare(props: {
  week: WeekData
  previous?: { sessions: number; cost: number; ms: number; errors: number; tools: number }
  money: (dollars: number) => string
}) {
  const language = useLanguage()
  const rate = (errors: number, tools: number) => (tools ? Math.round((1 - errors / tools) * 100) : 100)
  const rows = () => {
    const before = props.previous
    if (!before) return []
    return [
      { label: language.t("lynx.week.compare.sessions"), was: String(before.sessions), now: String(props.week.sessions), up: props.week.sessions >= before.sessions, good: true },
      { label: language.t("lynx.week.compare.cost"), was: props.money(before.cost), now: props.money(props.week.cost), up: props.week.cost >= before.cost, good: false },
      { label: language.t("lynx.week.compare.time"), was: hours(before.ms), now: hours(props.week.modelMs + props.week.toolMs), up: props.week.modelMs + props.week.toolMs >= before.ms, good: true },
      { label: language.t("lynx.week.compare.success"), was: `${rate(before.errors, before.tools)}%`, now: `${rate(props.week.errors, props.week.tools)}%`, up: rate(props.week.errors, props.week.tools) >= rate(before.errors, before.tools), good: true },
    ]
  }
  return (
    <section class="lynx-card">
      <h2>{language.t("lynx.week.compare")}</h2>
      <div class="lynx-compare">
        <span />
        <span class="lynx-mute2">{language.t("lynx.week.compare.before")}</span>
        <span class="lynx-mute2">{language.t("lynx.week.compare.now")}</span>
        <span />
        <For each={rows()}>
          {(row, index) => (
            <>
              <b>{row.label}</b>
              <span class="lynx-mute2">{row.was}</span>
              <span class="lynx-compare-now" style={{ "animation-delay": `${index() * 90}ms` }}>
                {row.now}
              </span>
              <span class="lynx-arrow" data-better={row.up === row.good ? "" : undefined}>
                {row.up ? "↑" : "↓"}
              </span>
            </>
          )}
        </For>
      </div>
    </section>
  )
}

/* ---------- Where the money went ---------- */

const SLICES = ["#22d3ee", "#6366f1", "#a5b4fc", "#0e7490", "#334155"]

function Money(props: { week: WeekData; money: (dollars: number) => string }) {
  const language = useLanguage()
  const slices = createMemo(() => {
    const sorted = [...props.week.models].filter((model) => model.cost > 0).sort((a, b) => b.cost - a.cost)
    const top = sorted.slice(0, 4)
    const rest = sorted.slice(4).reduce((sum, model) => sum + model.cost, 0)
    const list = [...top.map((model) => ({ name: model.model, cost: model.cost })), ...(rest ? [{ name: language.t("lynx.week.money.other"), cost: rest }] : [])]
    const total = list.reduce((sum, item) => sum + item.cost, 0) || 1
    let offset = 0
    return list.map((item, index) => {
      const share = (item.cost / total) * 100
      const slice = { ...item, share, offset, color: SLICES[index] }
      offset += share
      return slice
    })
  })
  return (
    <section class="lynx-card">
      <h2>{language.t("lynx.week.money")}</h2>
      <div class="lynx-donut">
        <svg viewBox="0 0 42 42" aria-hidden="true">
          <circle cx="21" cy="21" r="15.9" class="lynx-donut-track" />
          <For each={slices()}>
            {(slice, index) => (
              <circle
                cx="21"
                cy="21"
                r="15.9"
                stroke={slice.color}
                stroke-dasharray={`${slice.share} ${100 - slice.share}`}
                stroke-dashoffset={25 - slice.offset}
                style={{ "animation-delay": `${index() * 150}ms` }}
              />
            )}
          </For>
        </svg>
        <div class="lynx-donut-total">
          <small>{language.t("lynx.week.money.total")}</small>
          <b>{props.money(props.week.cost)}</b>
        </div>
      </div>
      <ul class="lynx-legend">
        <For each={slices()}>
          {(slice) => (
            <li>
              <i style={{ background: slice.color }} />
              <span>{slice.name}</span>
              <b>{props.money(slice.cost)}</b>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}

/* ---------- The month as a calendar ---------- */

function Calendar() {
  const json = useServerJson()
  const language = useLanguage()
  const month = DateTime.local().startOf("month")
  const [days] = createResource(
    async () => {
      const count = DateTime.local().day
      const starts = Array.from({ length: count + 1 }, (_, index) => month.plus({ days: index }).toMillis())
      const totals = await Promise.all(
        starts.map((since) => json<{ total: number }>("/experimental/usage/spend", { since: String(since) }).then((value) => value?.total ?? 0)),
      )
      return starts.slice(0, count).map((start, index) => ({ start, cost: Math.max(0, totals[index] - totals[index + 1]) }))
    },
    { initialValue: [] },
  )
  const peak = () => Math.max(0.0001, ...days.latest.map((day) => day.cost))
  const blanks = () => Array.from({ length: (month.weekday + 6) % 7 })
  return (
    <section class="lynx-card">
      <h2>{month.setLocale(language.intl()).toFormat("LLLL")}</h2>
      <div class="lynx-cal">
        <For each={["S", "T", "Q", "Q", "S", "S", "D"]}>{(label) => <span class="lynx-cal-head">{label}</span>}</For>
        <For each={blanks()}>{() => <span />}</For>
        <For each={days.latest}>
          {(day, index) => (
            <span
              class="lynx-cal-day"
              title={language.t("lynx.week.cal.title", { day: index() + 1 })}
              data-today={index() + 1 === DateTime.local().day ? "" : undefined}
              style={{ "--v": String(day.cost / peak()), "animation-delay": `${Math.floor(index() / 7) * 90}ms` }}
            >
              {index() + 1}
            </span>
          )}
        </For>
      </div>
    </section>
  )
}

/* ---------- Achievements ---------- */

function Badges(props: { week: WeekData }) {
  const language = useLanguage()
  const prefs = useLynxPrefs()
  const success = () => (props.week.tools ? 1 - props.week.errors / props.week.tools : 1)
  const badges = () => [
    { id: "sessions", icon: "💬", on: props.week.sessions >= 10 },
    { id: "steps", icon: "🎯", on: props.week.steps >= 100 },
    { id: "browser", icon: "🧭", on: props.week.browserActions >= 50 },
    { id: "notebook", icon: "📓", on: props.week.notebook >= 5 },
    { id: "careful", icon: "🛡", on: props.week.tools >= 20 && success() >= 0.95 },
    { id: "budget", icon: "💰", on: prefs.get("monthlyBudget") > 0 && props.week.cost * 5 <= prefs.get("monthlyBudget") / 4 },
  ]
  return (
    <section class="lynx-card">
      <h2>{language.t("lynx.week.badges")}</h2>
      <div class="lynx-badges">
        <For each={badges()}>
          {(badge, index) => (
            <div class="lynx-badge" data-on={badge.on ? "" : undefined} style={{ "--i": String(index()) }}>
              <span>{badge.icon}</span>
              <small>{language.t(`lynx.week.badge.${badge.id}` as never)}</small>
            </div>
          )}
        </For>
      </div>
    </section>
  )
}

/* ---------- The week's pictures ---------- */

function Photos(props: { week: WeekData }) {
  const language = useLanguage()
  const global = useGlobal()
  const server = useServer()
  const json = useServerJson()
  const [shots] = createResource(
    () => props.week.topSessions.slice(0, 5).map((session) => session.id).join(","),
    async () => {
      const connection = server.current
      if (!connection) return []
      const sync = global.ensureServerCtx(connection).sync
      return Promise.all(
        props.week.topSessions.slice(0, 5).map(async (session) => {
          await sync.session.sync(session.id).catch(() => undefined)
          const calls = (sync.session.data.message[session.id] ?? []).flatMap((message) =>
            (sync.session.data.part[message.id] ?? []).flatMap((part) =>
              part.type === "tool" && part.tool.startsWith("browser_") && part.state.status === "completed" ? [part.callID] : [],
            ),
          )
          const last = calls.at(-1)
          const shot = last
            ? await json<{ image?: string }>(`/experimental/browser/trail/${session.id}/${last}`).catch(() => undefined)
            : undefined
          return { title: session.title, image: shot?.image }
        }),
      )
    },
    { initialValue: [] },
  )
  const tilt = [-5, 3, -2, 4, -3]
  return (
    <section class="lynx-card lynx-wide">
      <h2>{language.t("lynx.week.photos")}</h2>
      <div class="lynx-photos">
        <For each={shots.latest}>
          {(photo, index) => (
            <figure style={{ "--r": `${tilt[index() % tilt.length]}deg`, "animation-delay": `${index() * 120}ms` }}>
              <Show when={photo.image} fallback={<div class="lynx-photo-blank" />}>
                <img src={photo.image} alt="" />
              </Show>
              <figcaption>{photo.title || language.t("week.untitled")}</figcaption>
            </figure>
          )}
        </For>
      </div>
    </section>
  )
}

/* ---------- A letter from Lynx ---------- */

function Letter(props: { week: WeekData; money: (dollars: number) => string }) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const worked = () => props.week.topSessions.slice(0, 3).map((session) => session.title).filter(Boolean)
  return (
    <section class="lynx-card lynx-letter-card lynx-two">
      <h2>{language.t("lynx.week.letter")}</h2>
      <button type="button" class="lynx-envelope" data-open={open() ? "" : undefined} onClick={() => setOpen(!open())}>
        <span class="lynx-flap" />
        <div class="lynx-letter">
          <p>{language.t("lynx.week.letter.hello")}</p>
          <p>
            {language.t("lynx.week.letter.did", {
              sessions: props.week.sessions,
              hours: hours(props.week.modelMs + props.week.toolMs),
              money: props.money(props.week.cost),
            })}
          </p>
          <Show when={worked().length}>
            <p>{language.t("lynx.week.letter.most", { list: worked().join(", ") })}</p>
          </Show>
          <Show when={props.week.topErrors[0]}>
            {(error) => <p>{language.t("lynx.week.letter.error", { error: error().message.slice(0, 80) })}</p>}
          </Show>
          <p class="lynx-sign">— Lynx</p>
        </div>
        <span class="lynx-pocket" />
      </button>
      <small class="lynx-mute2">{open() ? language.t("lynx.week.letter.close") : language.t("lynx.week.letter.open")}</small>
    </section>
  )
}

/* ---------- Next week's plan ---------- */

const PLAN_KEY = "lynx.week.plan"
type PlanItem = { id: string; text: string; day: number }

function Plan(props: { week: WeekData }) {
  const language = useLanguage()
  const [plan, setPlan] = createSignal<PlanItem[]>(read())
  const save = (next: PlanItem[]) => {
    setPlan(next)
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify(next))
    } catch {}
  }
  const ideas = createMemo(() => {
    const list = [
      ...props.week.topErrors.slice(0, 2).map((error) => language.t("lynx.week.plan.fix", { error: error.message.slice(0, 60) })),
      ...props.week.topSessions.slice(0, 2).map((session) => language.t("lynx.week.plan.continue", { title: session.title })),
      ...(props.week.notebook ? [language.t("lynx.week.plan.review", { count: props.week.notebook })] : []),
    ]
    return list.filter((text) => !plan().some((item) => item.text === text))
  })
  const days = () =>
    Array.from({ length: 5 }, (_, index) => DateTime.local().plus({ weeks: 1 }).startOf("week").plus({ days: index }))
  const accept = (text: string) => {
    const counts = days().map((_, day) => plan().filter((item) => item.day === day).length)
    const day = counts.indexOf(Math.min(...counts))
    save([...plan(), { id: `${Date.now()}-${text.length}`, text, day }])
  }
  return (
    <section class="lynx-card lynx-wide">
      <h2>{language.t("lynx.week.plan")}</h2>
      <div class="lynx-plan">
        <div class="lynx-plan-ideas">
          <span class="lynx-mute2">{language.t("lynx.week.plan.suggests")}</span>
          <For each={ideas()} fallback={<p class="lynx-mute2">{language.t("lynx.week.plan.none")}</p>}>
            {(text) => (
              <div class="lynx-plan-idea">
                <span>{text}</span>
                <button type="button" onClick={() => accept(text)}>
                  {language.t("lynx.week.plan.accept")}
                </button>
              </div>
            )}
          </For>
        </div>
        <div class="lynx-plan-days">
          <For each={days()}>
            {(day, index) => (
              <div class="lynx-plan-day">
                <span class="lynx-mute2">{day.setLocale(language.intl()).toFormat("ccc d")}</span>
                <For each={plan().filter((item) => item.day === index())}>
                  {(item) => (
                    <button
                      type="button"
                      class="lynx-plan-item"
                      title={language.t("lynx.week.plan.remove")}
                      onClick={() => save(plan().filter((entry) => entry.id !== item.id))}
                    >
                      {item.text}
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </section>
  )
}

function read(): PlanItem[] {
  try {
    return JSON.parse(localStorage.getItem(PLAN_KEY) ?? "[]")
  } catch {
    return []
  }
}
