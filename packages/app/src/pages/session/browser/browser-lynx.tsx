import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerJson } from "@/utils/server-json"
import type { BrowserActivity, BrowserCommand, BrowserStatus } from "./browser-feed"
import "./browser-lynx.css"

export type LynxView = "tabs" | "notes" | "lite" | undefined

type SiteInfo = {
  host: string
  notes: { text: string; at: number }[]
  programs: { name: string; description: string; runs: number; failures: number }[]
}

function host(url: string | undefined) {
  if (!url) return ""
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * What sits over the live page: who is in control and the button to take
 * over, the recording light, a highlighter sweeping the page while Lynx reads
 * it, every open tab as a grid, and the notes Lynx keeps about the site.
 */
export function BrowserLynxLayer(props: {
  status: Accessor<BrowserStatus | undefined>
  activity: Accessor<BrowserActivity | undefined>
  agentActive: Accessor<boolean>
  working: Accessor<boolean>
  view: Accessor<LynxView>
  setView: (view: LynxView) => void
  control: (command: BrowserCommand) => void
  onTakeOver?: () => void
  directory: Accessor<string | undefined>
}) {
  const language = useLanguage()
  const json = useServerJson()
  const [since, setSince] = createSignal<number>()
  const [tick, setTick] = createSignal(Date.now())
  const timer = setInterval(() => setTick(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  // The recording runs from when the session starts working until it stops.
  createEffect(
    on(props.working, (working) => setSince(working ? Date.now() : undefined)),
  )
  const elapsed = () => {
    const start = since()
    if (!start) return "0:00"
    const seconds = Math.max(0, Math.floor((tick() - start) / 1000))
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }
  const reading = createMemo(() => {
    const activity = props.activity()
    return !!activity && activity.kind === "read" && tick() - activity.at < 2500
  })

  const url = () => props.status()?.url
  const [site, { mutate }] = createResource(
    () => (props.view() === "notes" ? url() : undefined),
    (value) =>
      json<SiteInfo>("/experimental/browser/site", {
        url: value,
        ...(props.directory() ? { directory: props.directory()! } : {}),
      }),
    { initialValue: undefined },
  )
  const forget = async (index: number) => {
    const value = url()
    if (!value) return
    const next = await json<SiteInfo>(
      "/experimental/browser/site",
      { url: value, note: String(index + 1), ...(props.directory() ? { directory: props.directory()! } : {}) },
      "DELETE",
    )
    if (next) mutate(next)
  }

  return (
    <>
      <Show when={props.working()}>
        <span class="lynx-rec" data-motion="l">
          <i />
          REC {elapsed()}
        </span>
      </Show>

      <Show when={reading()}>
        <div class="lynx-reading" aria-hidden="true">
          <For each={[0, 1, 2, 3, 4]}>{(index) => <i style={{ "animation-delay": `${index * 140}ms` }} />}</For>
        </div>
      </Show>

      <Show when={props.agentActive() && props.onTakeOver}>
        <div class="lynx-remote" data-motion="l">
          <span class="lynx-remote-dot" />
          <b>{language.t("lynx.browser.inControl")}</b>
          <button type="button" onClick={() => props.onTakeOver?.()}>
            ✋ {language.t("lynx.browser.takeOver")}
          </button>
        </div>
      </Show>

      <Show when={props.view() === "lite"}>
        <div class="lynx-lite" data-motion="l">
          <span class="lynx-lite-badge">{language.t("lynx.browser.lite")}</span>
          <b>{props.status()?.title || host(url())}</b>
          <code>{url()}</code>
          <Show when={props.activity()}>
            {(activity) => (
              <p>
                <span class="lynx-remote-dot" /> {activity().kind}
                {activity().target ? ` · ${activity().target}` : ""}
              </p>
            )}
          </Show>
          <button type="button" onClick={() => props.setView(undefined)}>
            {language.t("lynx.browser.lite.show")}
          </button>
        </div>
      </Show>

      <Show when={props.view() === "tabs"}>
        <div class="lynx-tabgrid" data-motion="l">
          <div class="lynx-tabgrid-head">
            <b>{language.t("lynx.browser.allTabs", { count: props.status()?.tabs.length ?? 0 })}</b>
            <button type="button" onClick={() => props.setView(undefined)}>
              ✕
            </button>
          </div>
          <div class="lynx-tabgrid-cards">
            <For each={props.status()?.tabs ?? []}>
              {(tab, index) => (
                <div class="lynx-tabcard" data-active={tab.active ? "" : undefined} style={{ "--i": String(index()) }}>
                  <button
                    type="button"
                    class="lynx-tabcard-open"
                    onClick={() => {
                      props.control({ action: "select_tab", tab: tab.id })
                      props.setView(undefined)
                    }}
                  >
                    <span class="lynx-tabcard-favicon">{(host(tab.url)[0] ?? "•").toUpperCase()}</span>
                    <b>{tab.title || host(tab.url)}</b>
                    <small>{host(tab.url)}</small>
                  </button>
                  <button
                    type="button"
                    class="lynx-tabcard-close"
                    aria-label={language.t("ui.browserPane.closeTab")}
                    onClick={() => props.control({ action: "close_tab", tab: tab.id })}
                  >
                    ✕
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={props.view() === "notes"}>
        <aside class="lynx-notes" data-motion="l">
          <div class="lynx-tabgrid-head">
            <b>{language.t("lynx.browser.notes", { site: host(url()) })}</b>
            <button type="button" onClick={() => props.setView(undefined)}>
              ✕
            </button>
          </div>
          <Show
            when={(site.latest?.notes.length ?? 0) + (site.latest?.programs.length ?? 0) > 0}
            fallback={<p class="lynx-notes-empty">{language.t("lynx.browser.notes.empty")}</p>}
          >
            <For each={site.latest?.notes ?? []}>
              {(note, index) => (
                <div class="lynx-note" style={{ "--r": `${((index() * 37) % 5) - 2}deg` }}>
                  <p>{note.text}</p>
                  <button type="button" onClick={() => void forget(index())}>
                    {language.t("lynx.browser.forget")}
                  </button>
                </div>
              )}
            </For>
            <Show when={site.latest?.programs.length}>
              <span class="lynx-notes-label">{language.t("lynx.browser.programs")}</span>
              <For each={site.latest?.programs ?? []}>
                {(program) => (
                  <div class="lynx-program" data-broken={program.failures >= 2 ? "" : undefined}>
                    <b>{program.name}</b>
                    <small>{program.description}</small>
                    <span>{language.t("lynx.browser.runs", { count: program.runs })}</span>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </aside>
      </Show>
    </>
  )
}

/** The buttons in the pane's tab strip for the views above and for floating the pane. */
export function BrowserLynxTools(props: {
  tabs: Accessor<number>
  view: Accessor<LynxView>
  setView: (view: LynxView) => void
  floating: Accessor<boolean>
  setFloating: (value: boolean) => void
  xray: Accessor<boolean>
  setXray: (value: boolean) => void
}) {
  const language = useLanguage()
  const toggle = (view: LynxView) => props.setView(props.view() === view ? undefined : view)
  return (
    <>
      <Show when={props.tabs() > 1}>
        <button
          type="button"
          class="browser-pane-icon lynx-tool"
          aria-pressed={props.view() === "tabs"}
          title={language.t("lynx.browser.allTabs", { count: props.tabs() })}
          onClick={() => toggle("tabs")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="2" width="5" height="5" rx="1" fill="currentColor" />
            <rect x="9" y="2" width="5" height="5" rx="1" fill="currentColor" />
            <rect x="2" y="9" width="5" height="5" rx="1" fill="currentColor" />
            <rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor" />
          </svg>
        </button>
      </Show>
      <button
        type="button"
        class="browser-pane-icon lynx-tool"
        aria-pressed={props.xray()}
        title={language.t("lynx.browser.xray")}
        onClick={() => props.setXray(!props.xray())}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2" y="3" width="6" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.2" />
          <rect x="8" y="9" width="6" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.2" />
        </svg>
      </button>
      <button
        type="button"
        class="browser-pane-icon lynx-tool"
        aria-pressed={props.view() === "lite"}
        title={language.t("lynx.browser.lite")}
        onClick={() => toggle("lite")}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 4h10M3 7h7M3 10h9M3 13h5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
      <button
        type="button"
        class="browser-pane-icon lynx-tool"
        aria-pressed={props.view() === "notes"}
        title={language.t("lynx.browser.notes.title")}
        onClick={() => toggle("notes")}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 2.5h10v8l-3 3H3z M10 13.5v-3h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        class="browser-pane-icon lynx-tool"
        aria-pressed={props.floating()}
        title={props.floating() ? language.t("lynx.browser.dock") : language.t("lynx.browser.float")}
        onClick={() => props.setFloating(!props.floating())}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <rect x="8" y="8" width="5" height="4" rx="0.8" fill="currentColor" />
        </svg>
      </button>
    </>
  )
}
