import type { Session } from "@opencode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { DateTime } from "luxon"
import {
  type Accessor,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { createUsdBrlRate } from "@/components/exchange-rate"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { HOME_VIEWS, type HomeView, useLynxPrefs } from "@/context/lynx-prefs"
import { ServerConnection } from "@/context/server"
import { sessionTitle } from "@/utils/session-title"
import { useServerJson } from "@/utils/server-json"
import type { HomeController } from "./home-controller"
import type { HomeSessionRecord, HomeSessionsController } from "./home-sessions-controller"
import "./lynx-home.css"

const DAY = 24 * 60 * 60 * 1000
const EXAMPLES = ["lynx.home.example.1", "lynx.home.example.2", "lynx.home.example.3"] as const
const SUGGESTIONS = ["prompt.example.2", "prompt.example.4", "prompt.example.3"] as const

/** The logo's circle with the prompt, drawn inline so it can breathe and take the page's motion rules. */
export function LynxMark(props: { size?: number; class?: string }) {
  return (
    <svg class={props.class} width={props.size ?? 40} height={props.size ?? 40} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <radialGradient id="lynx-mark-grad" cx="0.5" cy="0.38" r="0.65">
          <stop offset="0" stop-color="#FF6B5B" />
          <stop offset="1" stop-color="#E5484D" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="21" fill="url(#lynx-mark-grad)" />
      <path
        d="M22 24 L30 31 L22 38"
        fill="none"
        stroke="#fff"
        stroke-width="4.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path class="lynx-mark-cursor" d="M33 40 H43" stroke="#fff" stroke-width="4.5" stroke-linecap="round" />
    </svg>
  )
}

/**
 * The front door: the logo, one question and the composer in the middle, with
 * the projects as tabs above it, and below it the work shown the way the person
 * picked — a dashboard, the projects, or one of the session lists.
 */
export function LynxHome(props: { home: HomeController; sessions: HomeSessionsController; list: JSX.Element }) {
  const prefs = useLynxPrefs()
  const language = useLanguage()
  const navigate = useNavigate()
  const view = () => prefs.get("homeView")
  // What changed since the last visit is measured from the visit before this one.
  const seen = prefs.get("homeSeen")
  onMount(() => prefs.set("homeSeen", Date.now()))
  const records = createMemo(() => props.sessions.data.groups().flatMap((group) => group.sessions))
  const ctx: HomeContext = { ...props, records, seen, money: createMoney() }

  return (
    <div class="lynx-home">
      <LynxHero home={props.home} sessions={props.sessions} />
      <nav class="lynx-views" aria-label={language.t("lynx.home.views")}>
        <For each={HOME_VIEWS}>
          {(item) => (
            <button
              type="button"
              aria-pressed={view() === item}
              data-motion="l"
              onClick={() => prefs.set("homeView", item)}
            >
              {language.t(`lynx.home.view.${item}`)}
            </button>
          )}
        </For>
        <button type="button" class="lynx-views-board" onClick={() => navigate("/board")}>
          {language.t("lynx.home.view.quadro")} ↗
        </button>
      </nav>
      <Switch>
        <Match when={view() === "painel"}>
          <Dashboard {...ctx} />
        </Match>
        <Match when={view() === "projetos"}>
          <ProjectWall {...ctx} />
        </Match>
        <Match when={view() === "lista"}>{props.list}</Match>
        <Match when={view() === "tabela"}>
          <DenseList {...ctx} />
        </Match>
        <Match when={view() === "previa"}>
          <ListPreview {...ctx} />
        </Match>
        <Match when={view() === "terminal"}>
          <Terminal {...ctx} />
        </Match>
        <Match when={view() === "ceu"}>
          <Sky {...ctx} />
        </Match>
      </Switch>
    </div>
  )
}

type HomeContext = {
  home: HomeController
  sessions: HomeSessionsController
  records: Accessor<HomeSessionRecord[]>
  seen: number
  money: (dollars: number) => string
}

function createMoney() {
  const language = useLanguage()
  const usdBrl = createUsdBrlRate()
  return (dollars: number) => {
    const rate = language.intl().toLowerCase().startsWith("pt") ? usdBrl() : undefined
    const amount = rate ? dollars * rate : dollars
    return new Intl.NumberFormat(language.intl(), {
      style: "currency",
      currency: rate ? "BRL" : "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
  }
}

function when(record: HomeSessionRecord) {
  return record.session.time.updated ?? record.session.time.created
}

function ago(ms: number, language: ReturnType<typeof useLanguage>) {
  return DateTime.fromMillis(ms).setLocale(language.intl()).toRelative() ?? ""
}

function useWorking(home: HomeController) {
  const global = useGlobal()
  return (session: Session) => {
    const conn = home.server.focused()
    if (!conn) return false
    return !!global.ensureServerCtx(conn).sync.session.data.session_working(session.id)
  }
}

/** The last few messages of a session, loading them on first look. */
function usePeek(home: HomeController) {
  const global = useGlobal()
  return (sessionID: string) => {
    const conn = home.server.focused()
    if (!conn) return []
    const store = global.ensureServerCtx(conn).sync
    void store.session.sync(sessionID).catch(() => undefined)
    return (store.session.data.message[sessionID] ?? []).slice(-8).map((message) => {
      const parts = store.session.data.part[message.id] ?? []
      return {
        role: message.role,
        text: parts
          .flatMap((part) => (part.type === "text" && part.text && !part.synthetic ? [part.text] : []))
          .join(" ")
          .slice(0, 280),
        tools: parts.filter((part) => part.type === "tool").length,
      }
    })
  }
}

/** "1 arquivo" or "3 arquivos": keys come in `.one` and plain forms. */
function count(language: ReturnType<typeof useLanguage>, key: string, value: number) {
  return language.t((value === 1 ? `${key}.one` : key) as never, { count: value })
}

function LynxHero(props: { home: HomeController; sessions: HomeSessionsController }) {
  const language = useLanguage()
  const canCreate = () => props.sessions.session.canCreate()
  const active = () => props.home.project.newSession()?.worktree
  const choose = (directory: string) => {
    const conn = props.home.server.focused()
    if (!conn) return
    props.home.selection.set({ server: ServerConnection.key(conn), directory })
  }
  return (
    <section class="lynx-hero">
      <LynxMark size={52} class="lynx-hero-mark" />
      <h1>{language.t("lynx.home.question")}</h1>
      <Show when={props.home.project.list().length > 1}>
        <div class="lynx-project-tabs" role="tablist" aria-label={language.t("lynx.home.projects")}>
          <For each={props.home.project.list()}>
            {(project) => (
              <button
                type="button"
                role="tab"
                aria-selected={active() === project.worktree}
                onClick={() => choose(project.worktree)}
              >
                {project.name || project.worktree.split(/[\\/]/).pop()}
              </button>
            )}
          </For>
        </div>
      </Show>
      <button
        type="button"
        class="lynx-hero-composer"
        disabled={!canCreate()}
        onClick={() => props.home.project.openNewSession()}
      >
        <span class="lynx-hero-examples" aria-hidden="true">
          <For each={EXAMPLES}>{(key) => <span>{language.t(key)}</span>}</For>
        </span>
        <span class="sr-only">{language.t("prompt.placeholder.simple")}</span>
        <span class="lynx-hero-send" aria-hidden="true">
          ↑
        </span>
      </button>
      <div class="lynx-hero-chips">
        <For each={SUGGESTIONS}>
          {(key, index) => (
            <button
              type="button"
              disabled={!canCreate()}
              style={{ "--d": `${0.2 + index() * 0.08}s` }}
              onClick={() => props.home.project.openNewSessionWithPrompt(language.t(key))}
            >
              {language.t(key)}
            </button>
          )}
        </For>
      </div>
    </section>
  )
}

/* ---------- Painel (bento) ---------- */

function Dashboard(props: HomeContext) {
  const language = useLanguage()
  const json = useServerJson()
  const working = useWorking(props.home)
  const today = () => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  const [spend] = createResource(
    () => json<{ total: number; messages: number }>("/experimental/usage/spend", { since: String(today()) }),
    { initialValue: undefined },
  )
  const todays = createMemo(() => props.records().filter((record) => when(record) >= today()))
  const last = () => props.records()[0]
  const files = () => todays().reduce((sum, record) => sum + (record.session.summary?.files ?? 0), 0)
  const fresh = createMemo(() =>
    props
      .records()
      .filter((record) => props.seen > 0 && when(record) > props.seen)
      .slice(0, 4),
  )
  const running = createMemo(() => props.records().filter((record) => working(record.session)))

  return (
    <div class="lynx-bento">
      <Show when={last()}>
        {(record) => (
          <article class="lynx-tile lynx-tile-continue" style={{ "--d": "0s" }}>
            <span class="lynx-label">{language.t("lynx.home.continue")}</span>
            <h2>{sessionTitle(record().session.title)}</h2>
            <p class="lynx-mute">
              {record().projectName} · {ago(when(record()), language)}
            </p>
            <ContinuePeek home={props.home} sessionID={record().session.id} />
            <div class="lynx-continue-facts">
              <Show when={working(record().session)}>
                <span class="lynx-chip lynx-chip-on">
                  <i class="lynx-dot lynx-pulse" /> {language.t("lynx.home.working")}
                </span>
              </Show>
              <Show when={record().session.summary?.files}>
                <span class="lynx-chip">
                  {count(language, "lynx.home.files", record().session.summary?.files ?? 0)}
                  <b class="lynx-add">+{record().session.summary?.additions ?? 0}</b>
                  <b class="lynx-del">−{record().session.summary?.deletions ?? 0}</b>
                </span>
              </Show>
              <Show when={record().session.cost}>
                <span class="lynx-chip">{props.money(record().session.cost ?? 0)}</span>
              </Show>
            </div>
            <div class="lynx-actions">
              <button type="button" class="lynx-btn" onClick={() => props.sessions.session.open(record().session)}>
                {language.t("lynx.home.continue.action")}
              </button>
              <button type="button" class="lynx-btn lynx-btn-ghost" onClick={() => props.sessions.session.create()}>
                {language.t("command.session.new")}
              </button>
            </div>
          </article>
        )}
      </Show>

      <article class="lynx-tile lynx-tile-gauges" style={{ "--d": "0.06s" }}>
        <span class="lynx-label">{language.t("lynx.home.today")}</span>
        <div class="lynx-gauges">
          <Gauge
            value={Math.min(1, (spend()?.total ?? 0) / 2)}
            label={language.t("lynx.home.gauge.spend")}
            text={spend() ? props.money(spend()!.total) : "—"}
          />
          <Gauge
            value={Math.min(1, todays().length / 10)}
            label={language.t("lynx.home.gauge.sessions")}
            text={String(todays().length)}
          />
          <Gauge value={Math.min(1, files() / 30)} label={language.t("lynx.home.gauge.files")} text={String(files())} />
        </div>
      </article>

      <article class="lynx-tile lynx-tile-news" style={{ "--d": "0.12s" }}>
        <span class="lynx-label">{language.t("lynx.home.news")}</span>
        <Show
          when={running().length + fresh().length > 0}
          fallback={<p class="lynx-mute lynx-empty">{language.t("lynx.home.news.empty")}</p>}
        >
          <ul class="lynx-feed">
            <For each={running()}>
              {(record) => (
                <li>
                  <span class="lynx-feed-icon lynx-spin-icon" />
                  <button type="button" onClick={() => props.sessions.session.open(record.session)}>
                    <b>{sessionTitle(record.session.title)}</b>
                    <span class="lynx-mute">{language.t("lynx.home.working")}</span>
                  </button>
                </li>
              )}
            </For>
            <For each={fresh().filter((record) => !working(record.session))}>
              {(record) => (
                <li>
                  <span class="lynx-feed-icon">✓</span>
                  <button type="button" onClick={() => props.sessions.session.open(record.session)}>
                    <b>{sessionTitle(record.session.title)}</b>
                    <span class="lynx-mute">
                      {record.projectName} · {ago(when(record), language)}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </article>

      <article class="lynx-tile lynx-tile-day" style={{ "--d": "0.18s" }}>
        <span class="lynx-label">{language.t("lynx.home.day")}</span>
        <Show
          when={todays().length > 0}
          fallback={<p class="lynx-mute lynx-empty">{language.t("lynx.home.day.empty")}</p>}
        >
          <ol class="lynx-day">
            <For each={todays().slice(0, 6)}>
              {(record) => (
                <li>
                  <i class="lynx-dot" />
                  <span class="lynx-time">{DateTime.fromMillis(when(record)).toFormat("HH:mm")}</span>
                  <button type="button" onClick={() => props.sessions.session.open(record.session)}>
                    <b>{sessionTitle(record.session.title)}</b>
                    <span class="lynx-mute">
                      {record.projectName}
                      <Show when={record.session.summary?.files}>
                        {" · "}
                        {count(language, "lynx.home.files", record.session.summary?.files ?? 0)}
                      </Show>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </article>

      <article class="lynx-tile lynx-tile-heat" style={{ "--d": "0.24s" }}>
        <span class="lynx-label">{language.t("lynx.home.rhythm")}</span>
        <Heatmap records={props.records()} />
      </article>
    </div>
  )
}

function ContinuePeek(props: { home: HomeController; sessionID: string }) {
  const peek = usePeek(props.home)
  const last = createMemo(() => {
    const messages = peek(props.sessionID).filter((message) => message.text)
    return {
      ask: clip(messages.findLast((message) => message.role === "user")?.text),
      answer: clip(messages.findLast((message) => message.role === "assistant")?.text),
    }
  })
  return (
    <div class="lynx-continue-peek">
      <Show when={last().ask}>{(text) => <p class="lynx-peek-ask">{text()}</p>}</Show>
      <Show when={last().answer}>
        {(text) => (
          <p class="lynx-peek-answer">
            <LynxMark size={16} /> {text()}
          </p>
        )}
      </Show>
    </div>
  )
}

function clip(text?: string) {
  if (!text) return undefined
  return text.length > 150 ? `${text.slice(0, 150).trimEnd()}…` : text
}

function Gauge(props: { value: number; label: string; text: string }) {
  return (
    <div class="lynx-gauge">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="40" class="lynx-gauge-track" />
        <circle
          cx="50"
          cy="50"
          r="40"
          class="lynx-gauge-value"
          pathLength="100"
          style={{ "--v": String(Math.max(0.02, props.value) * 100) }}
        />
      </svg>
      <b>{props.text}</b>
      <span>{props.label}</span>
    </div>
  )
}

/** Weeks as columns and days as rows, brighter where more sessions were touched. */
function Heatmap(props: { records: HomeSessionRecord[] }) {
  const language = useLanguage()
  const WEEKS = 52
  const cells = createMemo(() => {
    const start = DateTime.local()
      .startOf("week")
      .minus({ weeks: WEEKS - 1 })
    const counts = new Map<string, number>()
    props.records.forEach((record) => {
      const key = DateTime.fromMillis(when(record)).toISODate() ?? ""
      counts.set(key, (counts.get(key) ?? 0) + 1)
    })
    return Array.from({ length: WEEKS * 7 }, (_, index) => {
      const day = start.plus({ days: Math.floor(index / 7) * 7 + (index % 7) })
      const count = counts.get(day.toISODate() ?? "") ?? 0
      return { day, count, future: day > DateTime.local() }
    })
  })
  const max = () => Math.max(1, ...cells().map((cell) => cell.count))
  return (
    <div class="lynx-heat" style={{ "--weeks": String(WEEKS) }}>
      <For each={cells()}>
        {(cell, index) => (
          <i
            data-future={cell.future ? "" : undefined}
            title={`${cell.day.setLocale(language.intl()).toFormat("d LLL")} · ${cell.count}`}
            style={{
              "--v": String(cell.count / max()),
              "animation-delay": `${Math.floor(index() / 7) * 25}ms`,
            }}
          />
        )}
      </For>
    </div>
  )
}

/* ---------- Projetos (parede) ---------- */

function ProjectWall(props: HomeContext) {
  const language = useLanguage()
  const cards = createMemo(() =>
    props.home.project.list().map((project) => {
      const own = props.records().filter((record) => record.project.worktree === project.worktree)
      return { project, own, last: own[0] }
    }),
  )
  const open = (directory: string) => {
    const conn = props.home.server.focused()
    if (conn) props.home.project.openProjectNewSession(conn, directory)
  }
  return (
    <div class="lynx-wall">
      <For each={cards()}>
        {(card, index) => (
          <article class="lynx-tile lynx-project" style={{ "--d": `${index() * 0.05}s` }}>
            <div class="lynx-project-thumb" aria-hidden="true">
              <For each={card.own.slice(0, 4)}>{(record) => <i>{sessionTitle(record.session.title)}</i>}</For>
            </div>
            <b>{card.project.name || card.project.worktree.split(/[\\/]/).pop()}</b>
            <span class="lynx-mute">
              {card.last ? ago(when(card.last), language) : language.t("lynx.home.never")} ·{" "}
              {count(language, "lynx.home.sessions", card.own.length)}
            </span>
            <div class="lynx-actions">
              <button type="button" class="lynx-btn" onClick={() => open(card.project.worktree)}>
                {language.t("command.session.new")}
              </button>
              <Show when={card.last}>
                {(record) => (
                  <button
                    type="button"
                    class="lynx-btn lynx-btn-ghost"
                    onClick={() => props.sessions.session.open(record().session)}
                  >
                    {language.t("lynx.home.last")}
                  </button>
                )}
              </Show>
            </div>
          </article>
        )}
      </For>
    </div>
  )
}

/* ---------- Tabela (lista densa) ---------- */

function DenseList(props: HomeContext) {
  const language = useLanguage()
  const working = useWorking(props.home)
  const [filter, setFilter] = createSignal<"all" | "running" | "today">("all")
  const rows = createMemo(() => {
    const start = DateTime.local().startOf("day").toMillis()
    if (filter() === "running") return props.records().filter((record) => working(record.session))
    if (filter() === "today") return props.records().filter((record) => when(record) >= start)
    return props.records()
  })
  return (
    <div class="lynx-dense">
      <div class="lynx-filters">
        <For each={["all", "running", "today"] as const}>
          {(item) => (
            <button type="button" aria-pressed={filter() === item} onClick={() => setFilter(item)}>
              {language.t(`lynx.home.filter.${item}`)}
            </button>
          )}
        </For>
      </div>
      <table>
        <thead>
          <tr>
            <th />
            <th>{language.t("lynx.home.col.title")}</th>
            <th>{language.t("lynx.home.col.project")}</th>
            <th>{language.t("lynx.home.col.model")}</th>
            <th>{language.t("lynx.home.col.cost")}</th>
            <th>{language.t("lynx.home.col.when")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(record) => (
              <tr
                tabIndex={0}
                data-fresh={props.seen > 0 && when(record) > props.seen ? "" : undefined}
                onClick={() => props.sessions.session.open(record.session)}
                onKeyDown={(event) => event.key === "Enter" && props.sessions.session.open(record.session)}
              >
                <td>
                  <i class={working(record.session) ? "lynx-dot lynx-pulse" : "lynx-dot lynx-dot-idle"} />
                </td>
                <td class="lynx-dense-title">{sessionTitle(record.session.title)}</td>
                <td class="lynx-mute">{record.projectName}</td>
                <td class="lynx-mute">{record.session.model?.id ?? "—"}</td>
                <td class="lynx-mono">{record.session.cost ? props.money(record.session.cost) : "—"}</td>
                <td class="lynx-mute">{ago(when(record), language)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

/* ---------- Prévia (lista e prévia) ---------- */

function ListPreview(props: HomeContext) {
  const language = useLanguage()
  const [picked, setPicked] = createSignal<string>()
  const current = createMemo(
    () => props.records().find((record) => record.session.id === picked()) ?? props.records()[0],
  )
  const peek = usePeek(props.home)
  const messages = createMemo(() => (current() ? peek(current()!.session.id) : []))
  return (
    <div class="lynx-preview">
      <ul class="lynx-preview-list">
        <For each={props.records().slice(0, 30)}>
          {(record) => (
            <li>
              <button
                type="button"
                aria-current={current()?.session.id === record.session.id}
                onMouseEnter={() => setPicked(record.session.id)}
                onFocus={() => setPicked(record.session.id)}
                onClick={() => props.sessions.session.open(record.session)}
              >
                <b>{sessionTitle(record.session.title)}</b>
                <span class="lynx-mute">
                  {ago(when(record), language)} · {record.projectName}
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={current()}>
        {(record) => (
          <section class="lynx-preview-pane" data-motion="l">
            <span class="lynx-label">{language.t("lynx.home.preview")}</span>
            <h2>{sessionTitle(record().session.title)}</h2>
            <div class="lynx-preview-msgs">
              <Show when={messages().length === 0}>
                <p class="lynx-mute lynx-preview-loading">{language.t("lynx.home.preview.loading")}</p>
              </Show>
              <For each={messages().filter((message) => message.text)}>
                {(message) => (
                  <div data-role={message.role}>
                    <p>{message.text}</p>
                  </div>
                )}
              </For>
              <Show when={messages().reduce((sum, message) => sum + message.tools, 0)}>
                {(tools) => <span class="lynx-chip">{count(language, "lynx.home.tools", tools())}</span>}
              </Show>
            </div>
            <button type="button" class="lynx-btn" onClick={() => props.sessions.session.open(record().session)}>
              {language.t("lynx.home.open")}
            </button>
          </section>
        )}
      </Show>
    </div>
  )
}

/* ---------- Terminal ---------- */

function Terminal(props: HomeContext) {
  const language = useLanguage()
  const [text, setText] = createSignal("")
  let input: HTMLInputElement | undefined
  const project = () => props.home.project.newSession()
  const folder = (path: string) => path.split(/[\\/]/).pop() ?? path
  const cycle = () => {
    const list = props.home.project.list()
    const conn = props.home.server.focused()
    if (!conn || list.length < 2) return
    const at = list.findIndex((item) => item.worktree === project()?.worktree)
    props.home.selection.set({ server: ServerConnection.key(conn), directory: list[(at + 1) % list.length].worktree })
  }
  onMount(() => input?.focus())
  return (
    <div class="lynx-term" onClick={() => input?.focus()}>
      <div class="lynx-term-head">
        <LynxMark size={18} />
        <b>Lynx Code</b>
        <span class="lynx-mute">{language.t("lynx.home.term.sessions", { count: props.records().length })}</span>
      </div>
      <For each={props.records().slice(0, 8).reverse()}>
        {(record) => (
          <button type="button" class="lynx-term-line" onClick={() => props.sessions.session.open(record.session)}>
            <span class="lynx-mute">lynx ~/{folder(record.project.worktree)} $ </span>
            <span>{sessionTitle(record.session.title)}</span>
            <span class="lynx-term-ok">
              {"  ✓ "}
              {record.session.summary?.files
                ? count(language, "lynx.home.files", record.session.summary.files) + " · "
                : ""}
              {ago(when(record), language)}
            </span>
          </button>
        )}
      </For>
      <form
        class="lynx-term-prompt"
        onSubmit={(event) => {
          event.preventDefault()
          if (!text().trim()) return
          props.home.project.openNewSessionWithPrompt(text().trim())
          setText("")
        }}
      >
        <span class="lynx-mute">lynx ~/{folder(project()?.worktree ?? "")} $</span>
        <input
          ref={input}
          value={text()}
          spellcheck={false}
          aria-label={language.t("prompt.placeholder.simple")}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return
            event.preventDefault()
            cycle()
          }}
        />
      </form>
      <div class="lynx-term-hint lynx-mute">
        <kbd>Enter</kbd> {language.t("lynx.home.term.send")} <kbd>Tab</kbd> {language.t("lynx.home.term.project")}
      </div>
    </div>
  )
}

/* ---------- Céu (constelação) ---------- */

function Sky(props: HomeContext) {
  const language = useLanguage()
  const W = 1000
  const H = 460
  const [hover, setHover] = createSignal<HomeSessionRecord>()
  const hash = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7)
  // Each project is a constellation of its own around the middle of the sky,
  // where Lynx sits; recent sessions shine near the heart of their project and
  // old ones drift outwards. Only the latest few are joined, like a figure.
  const clusters = createMemo(() => {
    const records = props.records()
    const projects = [...new Set(records.map((record) => record.project.worktree))]
    // Each project owns a slice of the ring around the middle; recent
    // sessions sit close to Lynx and older ones drift towards the edge.
    const slice = (Math.PI * 2) / Math.max(1, projects.length)
    return projects.map((worktree, index) => {
      const start = index * slice - Math.PI / 2
      const list = records.filter((record) => record.project.worktree === worktree).sort((a, b) => when(b) - when(a))
      const stars = list.map((record, order) => {
        const seed = hash(record.session.id)
        const turn = start + ((seed % 1000) / 1000) * slice * 0.9
        const reach = 120 + Math.sqrt(order / Math.max(1, list.length - 1)) * 300 + ((seed >> 10) % 40)
        return {
          record,
          x: Math.max(14, Math.min(W - 14, W / 2 + Math.cos(turn) * reach * 1.25)),
          y: Math.max(14, Math.min(H - 14, H / 2 + Math.sin(turn) * reach * 0.55)),
          r: order < 3 ? 3.4 : 1.4 + Math.min(2.6, Math.sqrt((record.session.cost ?? 0) * 30)),
          delay: (seed % 3000) / 1000,
        }
      })
      const middle = start + slice * 0.45
      return {
        worktree,
        name: list[0]?.projectName ?? "",
        cx: W / 2 + Math.cos(middle) * 440,
        cy: H / 2 + Math.sin(middle) * 200,
        stars,
        // The newest few, joined around the ring so the figure never cuts through the middle.
        figure: stars
          .slice(0, 7)
          .toSorted((a, b) => Math.atan2(a.y - H / 2, a.x - W / 2) - Math.atan2(b.y - H / 2, b.x - W / 2)),
      }
    })
  })
  // Faint dust behind the stars, the same every time.
  const dust = Array.from({ length: 90 }, (_, index) => ({
    x: (index * 7919) % W,
    y: (index * 104729) % H,
    r: 0.4 + ((index * 31) % 10) / 14,
  }))
  return (
    <div class="lynx-sky">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={language.t("lynx.home.view.ceu")}>
        <For each={dust}>{(speck) => <circle class="lynx-sky-dust" cx={speck.x} cy={speck.y} r={speck.r} />}</For>
        <For each={clusters()}>
          {(cluster) => (
            <g>
              <For each={cluster.figure.slice(1)}>
                {(star, index) => (
                  <Show when={Math.hypot(star.x - cluster.figure[index()].x, star.y - cluster.figure[index()].y) < 240}>
                    <line
                      x1={cluster.figure[index()].x}
                      y1={cluster.figure[index()].y}
                      x2={star.x}
                      y2={star.y}
                      style={{ "animation-delay": `${0.4 + index() * 0.18}s` }}
                    />
                  </Show>
                )}
              </For>
              <For each={cluster.stars}>
                {(star) => (
                  <circle
                    class="lynx-sky-star"
                    cx={star.x}
                    cy={star.y}
                    r={star.r}
                    tabIndex={0}
                    style={{ "animation-delay": `${star.delay}s` }}
                    onMouseEnter={() => setHover(star.record)}
                    onFocus={() => setHover(star.record)}
                    onClick={() => props.sessions.session.open(star.record.session)}
                  >
                    <title>{sessionTitle(star.record.session.title)}</title>
                  </circle>
                )}
              </For>
              <text
                x={Math.max(60, Math.min(W - 60, cluster.cx))}
                y={Math.max(24, Math.min(H - 12, cluster.cy))}
                text-anchor="middle"
              >
                {cluster.name}
              </text>
            </g>
          )}
        </For>
      </svg>
      <div class="lynx-sky-center">
        <LynxMark size={40} class="lynx-sky-mark" />
        <strong>{language.t("lynx.home.sky.next", { count: props.records().length })}</strong>
        <button
          type="button"
          disabled={!props.sessions.session.canCreate()}
          onClick={() => props.home.project.openNewSession()}
        >
          {language.t("command.session.new")}
        </button>
      </div>
      <p class="lynx-sky-caption">
        <Show when={hover()} fallback={language.t("lynx.home.sky.count", { count: props.records().length })}>
          {(record) => (
            <>
              <b>{sessionTitle(record().session.title)}</b> · {record().projectName} · {ago(when(record()), language)}
            </>
          )}
        </Show>
      </p>
    </div>
  )
}

export type { HomeView }
