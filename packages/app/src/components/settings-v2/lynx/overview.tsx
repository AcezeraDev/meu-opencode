import { useTheme } from "@opencode-ai/ui/theme/context"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLynxPrefs, type LynxPrefs } from "@/context/lynx-prefs"
import { useModels } from "@/context/models"
import { useSettings } from "@/context/settings"
import { useServerJson } from "@/utils/server-json"
import "./lynx-settings.css"

type Go = (tab: string, search?: string) => void

/** Folds "Notificação" and "notificacao" to the same words. */
export function fold(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

/**
 * The settings front page: say what you want to change, every area as a card
 * with what is on, ready-made profiles, and a health check of what Lynx needs.
 */
export function LynxOverview(props: { go: Go }) {
  const language = useLanguage()
  return (
    <div class="lynx-set">
      <header class="lynx-set-head">
        <h2>{language.t("lynx.set.overview")}</h2>
        <p>{language.t("lynx.set.overview.lead")}</p>
      </header>
      <AskBox go={props.go} />
      <AreaCards go={props.go} />
      <Profiles />
      <Health />
    </div>
  )
}

/* ---------- Say what you want to change ---------- */

type Intent = {
  words: string[]
  label: string
  hint: string
  tab: string
  search?: string
  apply?: () => void
}

function useIntents(): () => Intent[] {
  const language = useLanguage()
  const prefs = useLynxPrefs()
  const theme = useTheme()
  const settings = useSettings()
  const t = (key: string) => language.t(key as never)
  return () => [
    {
      words: ["escuro", "noite", "dark", "preto"],
      label: t("lynx.set.intent.dark"),
      hint: t("lynx.set.tab.looks"),
      tab: "lynx-looks",
      apply: () => {
        theme.setColorScheme("dark")
        prefs.set("variant", "noite")
      },
    },
    {
      words: ["claro", "dia", "light", "branco"],
      label: t("lynx.set.intent.light"),
      hint: t("lynx.set.tab.looks"),
      tab: "lynx-looks",
      apply: () => {
        theme.setColorScheme("light")
        prefs.set("variant", "dia")
      },
    },
    {
      words: ["contraste", "enxergar", "ler melhor", "vista"],
      label: t("lynx.set.intent.contrast"),
      hint: t("lynx.set.tab.looks"),
      tab: "lynx-looks",
      apply: () => {
        theme.setColorScheme("dark")
        prefs.set("variant", "contraste")
      },
    },
    {
      words: ["gasto", "gastar", "limite", "orcamento", "dinheiro", "reais", "custo", "caro", "barato"],
      label: t("lynx.set.intent.budget"),
      hint: t("lynx.set.tab.budget"),
      tab: "lynx-budget",
    },
    {
      words: ["permiss", "perguntar", "autoriz", "comprar", "pagar", "publicar", "bloquear"],
      label: t("lynx.set.intent.permissions"),
      hint: t("lynx.set.tab.permissions"),
      tab: "lynx-permissions",
    },
    {
      words: ["modelo", "escrever", "redator", "programar", "papel", "ia", "lynx rapido"],
      label: t("lynx.set.intent.roles"),
      hint: t("lynx.set.tab.roles"),
      tab: "lynx-roles",
    },
    {
      words: ["atalho", "tecla", "teclado", "ctrl"],
      label: t("lynx.set.intent.keys"),
      hint: t("settings.tab.shortcuts"),
      tab: "shortcuts",
    },
    {
      words: ["balao", "baloes", "whatsapp", "celular", "bolha"],
      label: t("lynx.set.intent.bubbles"),
      hint: t("lynx.chat.style"),
      tab: "lynx-looks",
      apply: () => prefs.set("chatStyle", "baloes"),
    },
    {
      words: ["animac", "leve", "pesado", "lento", "travando", "rapido"],
      label: t("lynx.set.intent.lite"),
      hint: t("settings.tab.general"),
      tab: "general",
      apply: () => settings.appearance.setLite(true),
    },
    {
      words: ["navegador", "brave", "cursor", "pagina", "site"],
      label: t("lynx.set.intent.browser"),
      hint: t("settings.tab.general"),
      tab: "general",
      search: "navegador",
    },
    {
      words: ["som", "sons", "barulho", "silencio", "mudo"],
      label: t("lynx.set.intent.sounds"),
      hint: t("settings.tab.general"),
      tab: "general",
      search: "som",
    },
    {
      words: ["foco", "concentr", "distra"],
      label: t("lynx.set.intent.focus"),
      hint: t("lynx.chat.style"),
      tab: "lynx-looks",
      apply: () => prefs.set("focus", true),
    },
    {
      words: ["inicio", "tela inicial", "painel", "comeco"],
      label: t("lynx.set.intent.home"),
      hint: t("lynx.set.tab.looks"),
      tab: "lynx-looks",
    },
    {
      words: ["voltar", "desfazer", "mudei", "historico", "quebrou"],
      label: t("lynx.set.intent.history"),
      hint: t("lynx.set.tab.history"),
      tab: "lynx-history",
    },
  ]
}

function AskBox(props: { go: Go }) {
  const language = useLanguage()
  const intents = useIntents()
  const [text, setText] = createSignal("")
  const [done, setDone] = createSignal<string>()
  const matches = createMemo(() => {
    const value = fold(text())
    if (value.trim().length < 3) return []
    return intents()
      .map((intent) => ({ intent, score: intent.words.filter((word) => value.includes(word)).length }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => item.intent)
  })
  return (
    <section class="lynx-ask">
      <label class="lynx-ask-field">
        <svg viewBox="0 0 64 64" width="22" height="22" aria-hidden="true">
          <circle cx="32" cy="32" r="21" fill="url(#lynx-set-grad)" />
          <defs>
            <radialGradient id="lynx-set-grad" cx="0.5" cy="0.38" r="0.65">
              <stop offset="0" stop-color="#22D3EE" />
              <stop offset="1" stop-color="#6366F1" />
            </radialGradient>
          </defs>
          <path d="M22 24 L30 31 L22 38" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" />
          <path d="M33 40 H43" stroke="#fff" stroke-width="5" stroke-linecap="round" />
        </svg>
        <input
          value={text()}
          placeholder={language.t("lynx.set.ask.placeholder")}
          onInput={(event) => {
            setText(event.currentTarget.value)
            setDone(undefined)
          }}
        />
      </label>
      <Show when={matches().length}>
        <div class="lynx-ask-results">
          <span class="lynx-set-label">{language.t("lynx.set.ask.found", { count: matches().length })}</span>
          <For each={matches()}>
            {(intent) => (
              <div class="lynx-ask-row">
                <div>
                  <b>{intent.label}</b>
                  <small>{intent.hint}</small>
                </div>
                <Show when={intent.apply}>
                  <button
                    type="button"
                    class="lynx-set-btn"
                    onClick={() => {
                      intent.apply?.()
                      setDone(intent.label)
                    }}
                  >
                    {done() === intent.label ? language.t("lynx.set.ask.applied") : language.t("lynx.set.ask.apply")}
                  </button>
                </Show>
                <button type="button" class="lynx-set-btn lynx-set-btn-ghost" onClick={() => props.go(intent.tab, intent.search)}>
                  {language.t("lynx.set.ask.open")}
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={text().trim().length >= 3 && !matches().length}>
        <p class="lynx-set-mute">{language.t("lynx.set.ask.none")}</p>
      </Show>
    </section>
  )
}

/* ---------- Areas ---------- */

function AreaCards(props: { go: Go }) {
  const language = useLanguage()
  const prefs = useLynxPrefs()
  const settings = useSettings()
  const models = useModels()
  const t = (key: string, params?: Record<string, string | number>) => language.t(key as never, params as never)
  const cards = () => [
    { tab: "lynx-looks", icon: "🎨", title: t("lynx.set.tab.looks"), state: `${t(`lynx.set.variant.${prefs.get("variant")}`)} · ${t(`lynx.chat.style.${prefs.get("chatStyle")}`)}` },
    { tab: "lynx-budget", icon: "💰", title: t("lynx.set.tab.budget"), state: prefs.get("monthlyBudget") ? t("lynx.set.budget.state", { value: prefs.get("monthlyBudget") }) : t("lynx.set.budget.none") },
    { tab: "lynx-permissions", icon: "🔐", title: t("lynx.set.tab.permissions"), state: settings.permissions.autoApprove() ? t("lynx.set.permissions.state.auto") : t("lynx.set.permissions.state.ask") },
    { tab: "lynx-roles", icon: "🤖", title: t("lynx.set.tab.roles"), state: t("lynx.set.roles.state", { count: models.list().length }) },
    { tab: "general", icon: "🧭", title: t("settings.general.section.browser"), state: t("lynx.set.browser.state") },
    { tab: "shortcuts", icon: "⌨", title: t("settings.tab.shortcuts"), state: "Ctrl+Shift+Espaço" },
    { tab: "providers", icon: "🔌", title: t("settings.providers.title"), state: t("lynx.set.providers.state") },
    { tab: "lynx-history", icon: "↶", title: t("lynx.set.tab.history"), state: t("lynx.set.history.state") },
  ]
  return (
    <section>
      <span class="lynx-set-label">{language.t("lynx.set.areas")}</span>
      <div class="lynx-areas">
        <For each={cards()}>
          {(card, index) => (
            <button type="button" class="lynx-area" style={{ "--d": `${index() * 0.04}s` }} onClick={() => props.go(card.tab)}>
              <span class="lynx-area-icon">{card.icon}</span>
              <b>{card.title}</b>
              <small>{card.state}</small>
            </button>
          )}
        </For>
      </div>
    </section>
  )
}

/* ---------- Profiles ---------- */

type Profile = { id: string; icon: string; prefs: Partial<LynxPrefs>; lite: boolean }

const PROFILES: Profile[] = [
  { id: "estudo", icon: "📚", prefs: { chatStyle: "documento", homeView: "painel", focus: false, settle: true, thread: true }, lite: false },
  { id: "trabalho", icon: "💼", prefs: { chatStyle: "cartoes", homeView: "tabela", focus: false, replay: true, thread: true }, lite: false },
  { id: "economico", icon: "🪙", prefs: { chatStyle: "coluna", homeView: "lista", settle: false, replay: false, thread: false }, lite: true },
]

function Profiles() {
  const language = useLanguage()
  const prefs = useLynxPrefs()
  const settings = useSettings()
  const [active, setActive] = createSignal<string>()
  const apply = (profile: Profile) => {
    for (const [key, value] of Object.entries(profile.prefs)) prefs.set(key as keyof LynxPrefs, value as never)
    settings.appearance.setLite(profile.lite)
    setActive(profile.id)
  }
  return (
    <section>
      <span class="lynx-set-label">{language.t("lynx.set.profiles")}</span>
      <div class="lynx-profiles">
        <For each={PROFILES}>
          {(profile) => (
            <div class="lynx-profile" data-active={active() === profile.id ? "" : undefined}>
              <span class="lynx-area-icon">{profile.icon}</span>
              <b>{language.t(`lynx.set.profile.${profile.id}` as never)}</b>
              <small>{language.t(`lynx.set.profile.${profile.id}.hint` as never)}</small>
              <button type="button" class="lynx-set-btn" onClick={() => apply(profile)}>
                {active() === profile.id ? language.t("lynx.set.profile.on") : language.t("lynx.set.profile.use")}
              </button>
            </div>
          )}
        </For>
      </div>
    </section>
  )
}

/* ---------- Health ---------- */

type Check = { id: string; ok: boolean | undefined; detail: string; fix?: string }

function Health() {
  const language = useLanguage()
  const json = useServerJson()
  const models = useModels()
  const [round, setRound] = createSignal(0)
  const [checks] = createResource(round, async () => {
    const started = performance.now()
    const status = await json<{ running: boolean; mode?: string }>("/experimental/browser/status")
    const ms = Math.round(performance.now() - started)
    const list = models.list()
    const local = list.some((model) => model.provider.id.includes("ollama"))
    const result: Check[] = [
      {
        id: "server",
        ok: status !== undefined,
        detail: status ? language.t("lynx.set.health.server.ok", { ms }) : language.t("lynx.set.health.server.no"),
      },
      {
        id: "browser",
        ok: status?.running === true,
        detail: status?.running
          ? language.t("lynx.set.health.browser.ok", { mode: status.mode ?? "" })
          : language.t("lynx.set.health.browser.no"),
        fix: status?.running ? undefined : language.t("lynx.set.health.browser.fix"),
      },
      {
        id: "models",
        ok: list.length > 0,
        detail: language.t("lynx.set.health.models", { count: list.length }),
      },
      {
        id: "local",
        ok: local,
        detail: local ? language.t("lynx.set.health.local.ok") : language.t("lynx.set.health.local.no"),
        fix: local ? undefined : language.t("lynx.set.health.local.fix"),
      },
      {
        id: "internet",
        ok: navigator.onLine,
        detail: navigator.onLine ? language.t("lynx.set.health.net.ok") : language.t("lynx.set.health.net.no"),
      },
    ]
    return result
  }, { initialValue: undefined })
  return (
    <section>
      <div class="lynx-set-row-head">
        <span class="lynx-set-label">{language.t("lynx.set.health")}</span>
        <button type="button" class="lynx-set-btn lynx-set-btn-ghost" onClick={() => setRound((value) => value + 1)}>
          {language.t("lynx.set.health.again")}
        </button>
      </div>
      <div class="lynx-health">
        <For each={checks.latest ?? []}>
          {(check, index) => (
            <div class="lynx-check" style={{ "--d": `${index() * 0.12}s` }}>
              <span class="lynx-check-state" data-ok={check.ok ? "" : undefined}>
                {check.ok ? "✓" : "!"}
              </span>
              <div>
                <b>{language.t(`lynx.set.health.${check.id}` as never)}</b>
                <small>{check.detail}</small>
              </div>
              <Show when={check.fix}>
                <span class="lynx-check-fix">{check.fix}</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </section>
  )
}
