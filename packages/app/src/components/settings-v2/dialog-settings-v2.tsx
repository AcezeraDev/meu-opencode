import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  startTransition,
} from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import { SettingsVideoV2 } from "./video"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLayout } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { slidingPill } from "@/utils/motion"
import { useLynxPrefs } from "@/context/lynx-prefs"
import { LynxOverview } from "./lynx/overview"
import { LynxLooks } from "./lynx/looks"
import { LynxBudget } from "./lynx/budget"
import { LynxPermissions } from "./lynx/permissions"
import { LynxRoles } from "./lynx/roles"
import { LynxChatSetup } from "./lynx/chat-setup"
import { LynxHistory } from "./lynx/history"
import { LynxKeyboard } from "./lynx/keyboard"

export const DialogSettings: Component<{
  sessionID?: string
  defaultValue?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  const prefs = useLynxPrefs()
  const [tab, setTab] = createSignal(props.defaultValue ?? "lynx-overview")
  const simple = () => prefs.get("settingsSimple")
  const lynxPages = [
    { value: "lynx-overview", icon: "◎", key: "lynx.set.overview" },
    { value: "lynx-looks", icon: "◐", key: "lynx.set.tab.looks" },
    { value: "lynx-budget", icon: "R$", key: "lynx.set.tab.budget" },
    { value: "lynx-permissions", icon: "⛨", key: "lynx.set.tab.permissions" },
    { value: "lynx-roles", icon: "◇", key: "lynx.set.tab.roles", advanced: true },
    { value: "lynx-talk", icon: "✦", key: "lynx.set.tab.talk" },
    { value: "lynx-history", icon: "↶", key: "lynx.set.tab.history", advanced: true },
  ]
  const directory = createMemo(() => {
    const route = layout.route()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return undefined
  })

  // Finding a setting: the search filters General's rows as you type and points
  // at the other pages whose name matches; with no search, General's sections
  // are listed under it to jump to.
  const [query, setQuery] = createSignal("")
  const [sections, setSections] = createSignal<{ title: string; element: HTMLElement }[]>([])
  const [found, setFound] = createSignal(0)
  /** Opens a page, optionally searching General for the words given. */
  const go = (value: string, search?: string) => {
    if (search) setQuery(search)
    void startTransition(() => setTab(search ? "general" : value))
  }
  let general: HTMLDivElement | undefined
  const words = createMemo(() => fold(query()).split(/\s+/).filter(Boolean))
  const pages = () => [
    { value: "shortcuts", label: language.t("settings.tab.shortcuts") },
    { value: "servers", label: language.t("status.popover.tab.servers") },
    { value: "providers", label: language.t("settings.providers.title") },
    { value: "models", label: language.t("settings.models.title") },
    { value: "video", label: language.t("settings.video.title") },
  ]
  const otherPages = createMemo(() => {
    const list = words()
    if (!list.length) return []
    return pages().filter((page) => list.every((word) => fold(page.label).includes(word)))
  })

  // Typing a search shows General's matches; clicking another page afterwards
  // still goes there, so only a change in the search moves to General.
  createEffect(
    on(
      words,
      (list) => {
        if (list.length && tab() !== "general") void startTransition(() => setTab("general"))
      },
      { defer: true },
    ),
  )

  createEffect(
    on([tab, words], ([, list]) => {
      // General renders its rows after this runs; read them on the next frame.
      requestAnimationFrame(() => {
        const root = general
        if (!root) return
        const rows = [...root.querySelectorAll<HTMLElement>('[data-component="settings-v2-row"]')]
        const shown = rows.filter((row) => {
          const hit = list.every((word) => fold(row.textContent ?? "").includes(word))
          row.toggleAttribute("data-filtered-out", !hit)
          return hit
        })
        for (const section of root.querySelectorAll<HTMLElement>(".settings-v2-section")) {
          const empty = !section.querySelector('[data-component="settings-v2-row"]:not([data-filtered-out])')
          section.toggleAttribute("data-filtered-out", list.length > 0 && empty)
        }
        setFound(shown.length)
        setSections(
          [...root.querySelectorAll<HTMLElement>(".settings-v2-section-title")].map((element) => ({
            title: element.textContent ?? "",
            element,
          })),
        )
      })
    }),
  )

  const showProviders = () => {
    void dialog.show(() => <DialogSettings sessionID={props.sessionID} defaultValue="providers" />)
  }

  let pageList!: HTMLDivElement
  onMount(() =>
    onCleanup(slidingPill(pageList, { active: '[data-slot="tabs-v2-trigger-wrapper"]:has([data-selected])' })),
  )

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="settings-v2"
      >
        <TabsV2.List ref={pageList}>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full">
              <label class="settings-v2-search">
                <Icon name="magnifying-glass" />
                <input
                  type="search"
                  value={query()}
                  placeholder={language.t("settings.search.placeholder")}
                  aria-label={language.t("settings.search.placeholder")}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || !query()) return
                    event.stopPropagation()
                    setQuery("")
                  }}
                />
              </label>
              <Show when={otherPages().length}>
                <div class="settings-v2-search-pages">
                  <span>{language.t("settings.search.alsoIn")}</span>
                  <For each={otherPages()}>
                    {(page) => (
                      <button
                        type="button"
                        onClick={() => {
                          setQuery("")
                          void startTransition(() => setTab(page.value))
                        }}
                      >
                        {page.label}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>Lynx Code</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <For each={lynxPages.filter((page) => !simple() || !page.advanced)}>
                      {(page) => (
                        <TabsV2.Trigger value={page.value}>
                          <span class="lynx-nav-ico" aria-hidden="true">
                            {page.icon}
                          </span>
                          {language.t(page.key as never)}
                        </TabsV2.Trigger>
                      )}
                    </For>
                  </div>
                </div>
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </TabsV2.Trigger>
                    <Show when={tab() === "general" && !words().length && sections().length}>
                      <nav class="settings-v2-sections" aria-label={language.t("settings.tab.general")}>
                        <For each={sections()}>
                          {(section) => (
                            <button
                              type="button"
                              onClick={() =>
                                section.element.scrollIntoView({
                                  block: "start",
                                  behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                                })
                              }
                            >
                              {section.title}
                            </button>
                          )}
                        </For>
                      </nav>
                    </Show>
                    <TabsV2.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </TabsV2.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5" hidden={simple()}>
                  <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="servers">
                      <Icon name="server" />
                      {language.t("status.popover.tab.servers")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="video">
                      <Icon name="photo" />
                      {language.t("settings.video.title")}
                    </TabsV2.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="lynx-set-modes" role="group" aria-label={language.t("lynx.set.mode")}>
              <button type="button" aria-pressed={simple()} onClick={() => prefs.set("settingsSimple", true)}>
                {language.t("lynx.set.mode.simple")}
              </button>
              <button type="button" aria-pressed={!simple()} onClick={() => prefs.set("settingsSimple", false)}>
                {language.t("lynx.set.mode.advanced")}
              </button>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>v{platform.version}</span>
            </div>
          </div>
        </TabsV2.List>
        <TabsV2.Content value="lynx-overview" class="settings-v2-panel">
          <LynxOverview go={go} />
        </TabsV2.Content>
        <TabsV2.Content value="lynx-looks" class="settings-v2-panel">
          <LynxLooks />
        </TabsV2.Content>
        <TabsV2.Content value="lynx-budget" class="settings-v2-panel">
          <LynxBudget />
        </TabsV2.Content>
        <TabsV2.Content value="lynx-permissions" class="settings-v2-panel">
          <LynxPermissions />
        </TabsV2.Content>
        <TabsV2.Content value="lynx-roles" class="settings-v2-panel">
          <LynxRoles />
        </TabsV2.Content>
        <TabsV2.Content value="lynx-talk" class="settings-v2-panel">
          <LynxChatSetup />
        </TabsV2.Content>
        <TabsV2.Content value="lynx-history" class="settings-v2-panel">
          <LynxHistory />
        </TabsV2.Content>
        <TabsV2.Content
          value="general"
          class="settings-v2-panel"
          ref={(element: HTMLDivElement) => (general = element)}
        >
          <Show when={words().length && !found()}>
            <p class="settings-v2-search-empty">{language.t("settings.search.empty", { query: query() })}</p>
          </Show>
          <SettingsGeneralV2 sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="shortcuts" class="settings-v2-panel">
          <LynxKeyboard />
          <SettingsKeybinds v2 />
        </TabsV2.Content>
        <TabsV2.Content value="servers" class="settings-v2-panel">
          <SettingsServersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="providers" class="settings-v2-panel">
          <SettingsProvidersV2 directory={directory} onBack={showProviders} />
        </TabsV2.Content>
        <TabsV2.Content value="models" class="settings-v2-panel">
          <SettingsModelsV2 />
        </TabsV2.Content>
        <TabsV2.Content value="video" class="settings-v2-panel">
          <SettingsVideoV2 directory={directory} />
        </TabsV2.Content>
      </TabsV2>
    </Dialog>
  )
}

/** Lowercase without accents, so "notificacao" finds "Notificação". */
function fold(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}
