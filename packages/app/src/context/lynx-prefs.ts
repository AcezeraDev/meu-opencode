import { createEffect, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform, type Platform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"

/** How the home page shows the work: a dashboard, the projects, or one of the session lists. */
export const HOME_VIEWS = ["painel", "projetos", "lista", "tabela", "previa", "terminal", "ceu"] as const
export type HomeView = (typeof HOME_VIEWS)[number]

/** The logo's palette, four ways: night (dark), day (light), high contrast, and strong cyan. */
export const VARIANTS = ["noite", "dia", "contraste", "ciano"] as const
export type Variant = (typeof VARIANTS)[number]

/** How the conversation reads: plain column, chat bubbles, a log, a document, or stacked step cards. */
export const CHAT_STYLES = ["coluna", "baloes", "log", "documento", "cartoes"] as const
export type ChatStyle = (typeof CHAT_STYLES)[number]

const DEFAULTS = {
  homeView: "painel" as HomeView,
  chatStyle: "coluna" as ChatStyle,
  /** The composer floats as a pill over the conversation. */
  pill: false,
  /** Only the last exchange stays sharp; older messages fade. */
  focus: false,
  /** Words of a streaming answer settle in from a soft blur. */
  settle: true,
  /** Steps of an answer hang on a vertical thread. */
  thread: true,
  /** The step scrubber under the conversation. */
  replay: false,
  /** Palette variant on top of the Lynx Code theme. */
  variant: "noite" as Variant,
  /** Monthly model budget in the person's money (reais); 0 means none. */
  monthlyBudget: 50,
  /** Settings show only the everyday pages and rows. */
  settingsSimple: false,
  /** Settings pages lay their sections in two columns on wide windows. */
  settingsWide: false,
  /** Where the command palette opens: in the middle, from the left edge, or dropping from the top. */
  paletteLayout: "centro" as "centro" | "lado" | "cortina",
  /** The palette shows results as a grid of tiles instead of a list. */
  paletteGrid: false,
  /** Last time the home page was opened, for the "since you were away" feed. */
  homeSeen: 0,
}

export type LynxPrefs = typeof DEFAULTS

let shared: ReturnType<typeof create> | undefined

/** The Lynx Code look-and-feel choices the person made, kept on this computer. */
export function useLynxPrefs() {
  const platform = usePlatform()
  shared ??= createRoot(() => create(platform))
  return shared
}

function create(platform: Platform) {
  const [store, setStore] = persisted(Persist.global("lynx.prefs"), createStore({ ...DEFAULTS }), platform)
  const get = <K extends keyof LynxPrefs>(key: K): LynxPrefs[K] => store[key] ?? DEFAULTS[key]

  // The conversation's look is pure CSS keyed on these attributes (lynx-chat.css).
  createEffect(() => {
    const root = document.documentElement
    root.dataset.chatStyle = get("chatStyle")
    toggle(root, "chatPill", get("pill"))
    toggle(root, "chatFocus", get("focus"))
    toggle(root, "chatSettle", get("settle"))
    toggle(root, "chatThread", get("thread"))
    root.dataset.lynxVariant = get("variant")
    toggle(root, "lynxSettingsWide", get("settingsWide"))
  })

  return {
    get,
    /** A plain copy of every choice, for the change history. */
    snapshot: () => ({ ...DEFAULTS, ...JSON.parse(JSON.stringify(store)) }) as LynxPrefs,
    set: <K extends keyof LynxPrefs>(key: K, value: LynxPrefs[K]) => setStore(key, value as never),
  }
}

function toggle(root: HTMLElement, key: string, on: boolean) {
  if (on) root.dataset[key] = ""
  if (!on) delete root.dataset[key]
}
