import { useTheme } from "@opencode-ai/ui/theme/context"
import { createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLynxPrefs, type ChatStyle, type HomeView, type Variant } from "@/context/lynx-prefs"
import { useSettings } from "@/context/settings"
import "./lynx-settings.css"

type Option = { label: string; apply: () => () => void }
type Step = { ask: string; options: Option[] }
type Done = { ask: string; answer: string; undo: () => void; undone: boolean }

/**
 * Setting things up by talking: Lynx asks one question at a time, each answer
 * changes the setting right away and leaves a card with Undo.
 */
export function LynxChatSetup() {
  const language = useLanguage()
  const prefs = useLynxPrefs()
  const settings = useSettings()
  const theme = useTheme()
  const t = (key: string, params?: Record<string, string | number>) => language.t(key as never, params as never)

  // Each option applies its change and hands back how to put things as they were.
  const pref = <K extends "monthlyBudget" | "chatStyle" | "homeView" | "variant">(key: K, value: never) => () => {
    const before = prefs.get(key)
    prefs.set(key, value)
    return () => prefs.set(key, before as never)
  }
  const steps: Step[] = [
    {
      ask: t("lynx.set.talk.q.budget"),
      options: [20, 50, 100, 0].map((value) => ({
        label: value ? t("lynx.set.talk.money", { value }) : t("lynx.set.budget.none"),
        apply: pref("monthlyBudget", value as never),
      })),
    },
    {
      ask: t("lynx.set.talk.q.style"),
      options: (["coluna", "baloes", "documento", "log", "cartoes"] as ChatStyle[]).map((style) => ({
        label: t(`lynx.chat.style.${style}`),
        apply: pref("chatStyle", style as never),
      })),
    },
    {
      ask: t("lynx.set.talk.q.ask"),
      options: [
        { label: t("lynx.set.talk.a.askAlways"), auto: false },
        { label: t("lynx.set.talk.a.askNever"), auto: true },
      ].map((item) => ({
        label: item.label,
        apply: () => {
          const before = settings.permissions.autoApprove()
          settings.permissions.setAutoApprove(item.auto)
          return () => settings.permissions.setAutoApprove(before)
        },
      })),
    },
    {
      ask: t("lynx.set.talk.q.home"),
      options: (["painel", "projetos", "lista", "tabela"] as HomeView[]).map((view) => ({
        label: t(`lynx.home.view.${view}`),
        apply: pref("homeView", view as never),
      })),
    },
    {
      ask: t("lynx.set.talk.q.variant"),
      options: (["noite", "dia", "contraste", "ciano"] as Variant[]).map((variant) => ({
        label: t(`lynx.set.variant.${variant}`),
        apply: () => {
          const undo = pref("variant", variant as never)()
          const scheme = theme.colorScheme()
          theme.setColorScheme(variant === "dia" ? "light" : "dark")
          return () => {
            undo()
            theme.setColorScheme(scheme)
          }
        },
      })),
    },
    {
      ask: t("lynx.set.talk.q.lite"),
      options: [
        { label: t("lynx.set.talk.a.lighter"), lite: true },
        { label: t("lynx.set.talk.a.fine"), lite: false },
      ].map((item) => ({
        label: item.label,
        apply: () => {
          const before = settings.appearance.lite()
          settings.appearance.setLite(item.lite)
          return () => settings.appearance.setLite(before)
        },
      })),
    },
  ]

  const [done, setDone] = createSignal<Done[]>([])
  const at = () => done().length
  const answer = (option: Option) => {
    const undo = option.apply()
    setDone([...done(), { ask: steps[at()].ask, answer: option.label, undo, undone: false }])
  }

  return (
    <div class="lynx-set">
      <header class="lynx-set-head">
        <h2>{t("lynx.set.tab.talk")}</h2>
        <p>{t("lynx.set.talk.lead")}</p>
      </header>
      <div class="lynx-talk">
        <For each={done()}>
          {(item, index) => (
            <>
              <p class="lynx-talk-lynx">{item.ask}</p>
              <p class="lynx-talk-me">{item.answer}</p>
              <div class="lynx-talk-card" data-undone={item.undone ? "" : undefined}>
                <span>{item.undone ? "↶" : "✓"}</span>
                <b>{item.undone ? t("lynx.set.talk.undone") : t("lynx.set.talk.saved", { value: item.answer })}</b>
                <Show when={!item.undone}>
                  <button
                    type="button"
                    class="lynx-set-btn lynx-set-btn-ghost"
                    onClick={() => {
                      item.undo()
                      setDone(done().map((entry, position) => (position === index() ? { ...entry, undone: true } : entry)))
                    }}
                  >
                    {t("lynx.set.undo")}
                  </button>
                </Show>
              </div>
            </>
          )}
        </For>
        <Show
          when={at() < steps.length}
          fallback={
            <>
              <p class="lynx-talk-lynx">{t("lynx.set.talk.end")}</p>
              <button type="button" class="lynx-set-btn lynx-set-btn-ghost" onClick={() => setDone([])}>
                {t("lynx.set.talk.again")}
              </button>
            </>
          }
        >
          <p class="lynx-talk-lynx lynx-talk-new">{steps[at()].ask}</p>
          <div class="lynx-chips">
            <For each={steps[at()].options}>
              {(option) => (
                <button type="button" onClick={() => answer(option)}>
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
