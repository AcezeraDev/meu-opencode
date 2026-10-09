import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { DateTime } from "luxon"
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import createPresence from "solid-presence"
import { PromptInputV2Composer } from "@/components/prompt-input-v2"
import { PromptGitStatus, PromptWorkspaceSelector } from "@/components/prompt-workspace-selector"
import {
  PromptProjectAddButton,
  PromptProjectSelector,
  type PromptProjectController,
} from "@/components/prompt-project-selector"
import { StatusPopoverV2 } from "@/components/status-popover"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import { LynxMark } from "@/pages/home/lynx-home"
import { sessionTitle } from "@/utils/session-title"
import { Persist, persisted } from "@/utils/persist"
import { useServerJson } from "@/utils/server-json"
import type { NewSessionDraftController } from "./new-session-draft-controller"
import type { NewSessionWorkspaceController } from "./new-session-workspace-controller"
import "./new-session-view.css"

const providerTipDismissalDuration = 30 * 24 * 60 * 60 * 1000

const EXAMPLES = [
  { key: "lynx.home.example.1", icon: "globe" },
  { key: "lynx.home.example.2", icon: "check" },
  { key: "lynx.home.example.3", icon: "edit" },
  { key: "prompt.example.7", icon: "split" },
] as const

export function NewSessionView(props: {
  input: NewSessionDraftController["input"]
  project: PromptProjectController
  workspace: NewSessionWorkspaceController
  onExample: (text: string) => void
}) {
  const language = useLanguage()
  const greeting = () => {
    const hour = new Date().getHours()
    if (hour < 5) return "lynx.new.hello.night"
    if (hour < 12) return "lynx.new.hello.morning"
    if (hour < 18) return "lynx.new.hello.afternoon"
    return "lynx.new.hello.evening"
  }

  return (
    <div class="@container relative flex flex-col min-h-0 h-full flex-1">
      <div
        data-component="session-new-design"
        class="relative flex-1 min-h-0 overflow-hidden rounded-[10px] bg-v2-background-bg-deep"
      >
        <div class="new-session-aurora" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div class="new-session-grid" aria-hidden="true" />
        <div class="absolute inset-0 overflow-y-auto">
          <div class="flex min-h-full items-center justify-center px-6 py-12">
            <div class={NEW_SESSION_CONTENT_WIDTH}>
              <div class="new-session-stack">
                <Show when={props.project.selected()}>
                  <div class="flex min-h-7 min-w-0 flex-col items-center justify-center gap-0 text-v2-text-text-faint sm:flex-row">
                    <PromptProjectSelector controller={props.project} placement="bottom" />
                    <Show
                      when={props.workspace.bar.visible()}
                      fallback={
                        <PromptGitStatus branch={props.workspace.bar.branch()} noGit={!props.workspace.project.git()} />
                      }
                    >
                      <PromptWorkspaceSelector
                        value={props.workspace.selection.value()}
                        projectRoot={props.workspace.project.root()}
                        workspaces={props.workspace.project.workspaces()}
                        branch={props.workspace.bar.branch()}
                        onChange={props.workspace.selection.set}
                        onDone={props.input.restoreFocus}
                      />
                    </Show>
                  </div>
                </Show>
                <div class="new-session-hello">
                  <LynxMark size={64} class="new-session-mark" />
                  <h1 class="new-session-title">{language.t(greeting())}</h1>
                  <p class="new-session-sub">{language.t("lynx.new.sub")}</p>
                </div>
                <FavoriteSkills input={props.input} />
                <div class="new-session-composer">
                  <PromptInputV2Composer controller={props.input} />
                </div>
                <Show when={props.project.empty()}>
                  <PromptProjectAddButton controller={props.project} />
                </Show>
                <div class="new-session-examples">
                  <For each={EXAMPLES}>
                    {(example, index) => (
                      <button
                        type="button"
                        class="new-session-example"
                        style={{ "--d": `${140 + index() * 50}ms` }}
                        onClick={() => props.onExample(language.t(example.key).replace(/…$/, ""))}
                      >
                        <IconV2 name={example.icon} />
                        <span>{language.t(example.key)}</span>
                      </button>
                    )}
                  </For>
                </div>
                <RecentSessions />
              </div>
            </div>
          </div>
        </div>
        <ProviderTip />
      </div>
    </div>
  )
}

/** A skill must have been used this often to earn a shortcut, so one-off tries stay out. */
const FAVORITE_MIN_USES = 2
const FAVORITE_LIMIT = 4

/**
 * The skills the person runs most, one click from the start of a conversation:
 * the click attaches the skill and puts the cursor in the box, so the request
 * goes in the same message instead of a greeting and "execute a skill" first.
 */
function FavoriteSkills(props: { input: NewSessionDraftController["input"] }) {
  const language = useLanguage()
  const json = useServerJson()
  const [usage] = createResource(
    () => json<{ skills: { name: string; count: number }[] }>("/experimental/usage/skills").catch(() => undefined),
    { initialValue: undefined },
  )
  const favorites = createMemo(() => {
    const known = new Map(props.input.skills.list().map((skill) => [skill.name, skill]))
    return (usage.latest?.skills ?? [])
      .filter((item) => item.count >= FAVORITE_MIN_USES)
      .flatMap((item) => {
        const skill = known.get(item.name)
        return skill ? [skill] : []
      })
      .slice(0, FAVORITE_LIMIT)
  })
  return (
    <Show when={favorites().length > 0}>
      <div class="new-session-favorites" role="group" aria-label={language.t("lynx.new.favorites")}>
        <span class="new-session-favorites-label">{language.t("lynx.new.favorites")}</span>
        <For each={favorites()}>
          {(skill, index) => (
            <button
              type="button"
              class="new-session-example"
              data-on={props.input.skills.selected().has(skill.name) ? "" : undefined}
              aria-pressed={props.input.skills.selected().has(skill.name)}
              title={skill.description}
              style={{ "--d": `${80 + index() * 50}ms` }}
              onClick={() => {
                props.input.skills.toggle(skill)
                props.input.restoreFocus()
              }}
            >
              <IconV2 name="grid-plus" />
              <span>{skill.name.replace(/[-_]+/g, " ")}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

/** Where the person left off in this project: the last sessions, one click away. */
function RecentSessions() {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const navigate = useNavigate()
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    onCleanup(() => clearInterval(timer))
  })
  const recent = createMemo(() =>
    serverSync()
      .child(sdk().directory)[0]
      .session.filter((session) => !session.parentID && !session.time.archived)
      .toSorted((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 3),
  )
  return (
    <Show when={recent().length > 0}>
      <section class="new-session-recent">
        <span class="new-session-recent-label">{language.t("lynx.new.continue")}</span>
        <For each={recent()}>
          {(session, index) => (
            <button
              type="button"
              style={{ "--d": `${320 + index() * 60}ms` }}
              onClick={() => navigate(`/${base64Encode(sdk().directory)}/session/${session.id}`)}
            >
              <span class="new-session-recent-dot" />
              <span class="new-session-recent-title">{sessionTitle(session.title) || language.t("command.session.new")}</span>
              <span class="new-session-recent-when">
                {(now(), DateTime.fromMillis(session.time.updated ?? session.time.created).setLocale(language.intl()).toRelative())}
              </span>
            </button>
          )}
        </For>
      </section>
    </Show>
  )
}

export function NewSessionStatus(props: { mount: Accessor<HTMLElement | null>; visible: Accessor<boolean> }) {
  const language = useLanguage()

  return (
    <Show when={props.mount()} keyed>
      {(mount) => (
        <Portal mount={mount}>
          <Show when={props.visible()}>
            <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
              <StatusPopoverV2 />
            </Tooltip>
          </Show>
        </Portal>
      )}
    </Show>
  )
}

function ProviderTip() {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const providers = useProviders(() => sdk().directory)
  const [persistedState, setPersistedState, , persistedReady] = persisted(
    Persist.global("new-session.provider-tip"),
    createStore({ dismissedAt: 0 }),
  )
  const visible = createMemo(
    () =>
      serverSync().child(sdk().directory)[0].provider_ready &&
      persistedReady() &&
      providers.paid().length === 0 &&
      Date.now() - persistedState.dismissedAt >= providerTipDismissalDuration,
  )
  const [ref, setRef] = createSignal<HTMLDivElement>()
  const presence = createPresence({
    show: visible,
    element: () => ref() ?? null,
  })
  const openProviders = () => {
    void import("@/components/dialog-connect-provider").then(({ DialogConnectProvider }) => {
      void dialog.show(() => <DialogConnectProvider directory={() => sdk().directory} />)
    })
  }

  return (
    <Show when={presence.present()}>
      <div class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-10">
        <div
          ref={setRef}
          data-component="provider-tip"
          data-visible={visible()}
          class="group/provider-tip pointer-events-auto relative flex h-6 max-w-full items-center transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.215,0.61,0.355,1)] motion-reduce:transition-none"
          classList={{ "data-[visible=false]:animate-out fade-out slide-out-to-bottom-4": true }}
        >
          <button
            type="button"
            class="flex h-6 min-w-0 items-center rounded-[4px] pl-1.5 text-[13px] leading-none tracking-[-0.04px] text-v2-text-text-faint transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-muted focus-visible:outline-none"
            onClick={openProviders}
          >
            <span class="truncate">{language.t("home.providerTip")}</span>
            <span class="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
              <IconV2 name="chevron-down" size="small" class="-rotate-90" />
            </span>
          </button>
          <TooltipV2
            class="hover-reveal absolute left-full top-0 flex h-6 w-7 items-center justify-end delay-0 duration-0 group-hover/provider-tip:delay-[250ms] group-hover/provider-tip:duration-150 group-hover/provider-tip:opacity-100 focus-within:delay-0 focus-within:duration-0 focus-within:opacity-100"
            placement="top"
            openDelay={1000}
            value={language.t("common.dismiss")}
          >
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-icon-icon-base focus-visible:outline-none"
              aria-label={language.t("common.dismiss")}
              onClick={() => setPersistedState("dismissedAt", Date.now())}
            >
              <IconV2 name="xmark-small" />
            </button>
          </TooltipV2>
        </div>
      </div>
    </Show>
  )
}
