import type { Session } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createUsdBrlRate } from "@/components/exchange-rate"
import { Odometer } from "@/components/odometer"
import { useLanguage } from "@/context/language"
import { useLynxPrefs } from "@/context/lynx-prefs"
import { useModels } from "@/context/models"
import { useSync } from "@/context/sync"
import { sessionTitle } from "@/utils/session-title"
import { LynxVoice } from "./lynx-voice"
import { LynxQuickDrawer } from "./lynx-quick-drawer"
import { LynxMark } from "./lynx-mark"
import "./lynx-chat.css"

/**
 * The strip next to a session's title: what the session cost so far, like a
 * taxi meter; how the conversation reads; focus; the step replay; and the
 * branches tried from the same starting point.
 */
export function LynxSessionBar(props: {
  session?: Session
  sessions: Session[]
  onOpenSession: (id: string) => void
}) {
  const language = useLanguage()
  const prefs = useLynxPrefs()
  const rate = createUsdBrlRate()
  const [menu, setMenu] = createSignal<"style" | "branches">()
  let root: HTMLDivElement | undefined

  const brl = () => language.intl().toLowerCase().startsWith("pt") && !!rate()
  const cost = createMemo(() => {
    const dollars = props.session?.cost ?? 0
    const amount = brl() ? dollars * (rate() ?? 1) : dollars
    return amount.toLocaleString(language.intl(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  })
  const sync = useSync()
  const models = useModels()
  // What the next message should cost: the whole context goes in again at the
  // model's input price, plus a typical answer at its output price.
  const next = createMemo(() => {
    const id = props.session?.id
    if (!id) return undefined
    const last = (sync().data.message[id] ?? []).findLast((message) => message.role === "assistant")
    if (!last || last.role !== "assistant") return undefined
    const model = models.list().find((item) => item.id === last.modelID && item.provider.id === last.providerID) as
      | { cost?: { input?: number; output?: number; cache?: { read?: number } } }
      | undefined
    if (!model?.cost?.input) return undefined
    const context = last.tokens.input + last.tokens.cache.read + last.tokens.output
    const dollars = (context * model.cost.input + 800 * (model.cost.output ?? 0)) / 1_000_000
    const amount = brl() ? dollars * (rate() ?? 1) : dollars
    return amount.toLocaleString(language.intl(), { minimumFractionDigits: 2, maximumFractionDigits: 3 })
  })
  const tokens = createMemo(() => {
    const value = props.session?.tokens
    if (!value) return 0
    return value.input + value.output + value.reasoning + value.cache.read + value.cache.write
  })

  // Forks are new sessions titled "<title> (fork #n)"; the branch family shares the base title.
  const base = (title: string) => title.replace(/ \(fork #\d+\)$/, "")
  const branches = createMemo(() => {
    const current = props.session
    if (!current) return []
    const family = base(current.title)
    const same = props.sessions.filter((item) => !item.parentID && item.directory === current.directory)
    const forks = same.filter((item) => item.title !== family && base(item.title) === family)
    if (forks.length === 0) return []
    // The original is the session with the plain title that existed when the first fork was made.
    const first = Math.min(...forks.map((item) => item.time.created))
    const original = same
      .filter((item) => item.title === family && item.time.created <= first)
      .sort((a, b) => b.time.created - a.time.created)[0]
    return [...(original ? [original] : []), ...forks.sort((a, b) => a.time.created - b.time.created)]
  })

  // The drawer lives in a portal, outside this strip, and has its own way to close.
  const close = (event: MouseEvent) => {
    const target = event.target as Element
    if (root && !root.contains(target) && !target.closest?.(".lynx-drawer, .lynx-drawer-scrim")) setMenu(undefined)
  }
  onMount(() => document.addEventListener("pointerdown", close))
  onCleanup(() => document.removeEventListener("pointerdown", close))

  return (
    <div class="lynx-session-bar" ref={root}>
      <LynxMark sessionID={props.session?.id} />
      <span
        class="lynx-meter"
        title={language.t("lynx.chat.meter.title", { tokens: tokens().toLocaleString(language.intl()) })}
      >
        <span class="lynx-meter-label">{brl() ? "R$" : "$"}</span>
        <Odometer value={cost()} />
      </span>
      <Show when={next()}>
        {(value) => (
          <span class="lynx-next" title={language.t("lynx.chat.next.title")}>
            {language.t("lynx.chat.next", { value: `${brl() ? "R$" : "$"} ${value()}` })}
          </span>
        )}
      </Show>

      <Show when={branches().length > 1}>
        <button
          type="button"
          class="lynx-bar-btn"
          aria-expanded={menu() === "branches"}
          title={language.t("lynx.chat.branches")}
          onClick={() => setMenu(menu() === "branches" ? undefined : "branches")}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M5 3v10M5 8c0-3 6-2 6-5M11 3v0" fill="none" stroke="currentColor" stroke-width="1.5" />
            <circle cx="5" cy="3" r="1.6" fill="currentColor" />
            <circle cx="5" cy="13" r="1.6" fill="currentColor" />
            <circle cx="11" cy="3" r="1.6" fill="currentColor" />
          </svg>
          {branches().length}
        </button>
      </Show>

      <LynxVoice />

      <button
        type="button"
        class="lynx-bar-btn"
        aria-pressed={prefs.get("replay")}
        title={language.t("lynx.chat.replay")}
        onClick={() => prefs.set("replay", !prefs.get("replay"))}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
        </svg>
      </button>

      <button
        type="button"
        class="lynx-bar-btn"
        aria-pressed={prefs.get("focus")}
        title={language.t("lynx.chat.focus")}
        onClick={() => prefs.set("focus", !prefs.get("focus"))}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </svg>
      </button>

      <button
        type="button"
        class="lynx-bar-btn"
        aria-expanded={menu() === "style"}
        title={language.t("lynx.chat.style")}
        onClick={() => setMenu(menu() === "style" ? undefined : "style")}
      >
        Aa
      </button>

      <Show when={menu() === "style"}>
        <LynxQuickDrawer onClose={() => setMenu(undefined)} />
      </Show>

      <Show when={menu() === "branches"}>
        <div class="lynx-pop lynx-branches" role="menu" data-motion="l">
          <span class="lynx-pop-label">{language.t("lynx.chat.branches")}</span>
          <div class="lynx-branch-list">
            <For each={branches()}>
              {(item, index) => (
                <button
                  type="button"
                  role="menuitem"
                  data-fork={index() > 0 ? "" : undefined}
                  aria-current={item.id === props.session?.id}
                  onClick={() => {
                    setMenu(undefined)
                    props.onOpenSession(item.id)
                  }}
                >
                  <b>
                    {index() === 0 ? language.t("lynx.chat.branch.main") : language.t("lynx.chat.branch.n", { n: index() })}
                  </b>
                  <small>{sessionTitle(item.title)}</small>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
