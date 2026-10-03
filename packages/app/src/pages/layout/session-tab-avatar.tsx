import type { LocalProject } from "@/context/layout"
import { getProjectAvatarVariant } from "@/context/layout"
import type { ServerConnection } from "@/context/server"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { createEta } from "@/pages/session/scope/eta"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { SessionProgressIndicatorV2 } from "@opencode-ai/session-ui/v2/session-progress-indicator-v2"
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import "./session-tab-avatar.css"

export function SessionTabAvatar(props: {
  project?: LocalProject
  directory: string
  sessionId: string
  server: ServerConnection.Key
  revealProjectOnHover?: boolean
  /** Show how far the work has come, from the time the server estimates is left. */
  progress?: boolean
}) {
  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.directory,
    () => props.sessionId,
  )
  const eta = createEta({ sessionID: () => props.sessionId, active: () => !!props.progress && state.loading() })
  // The share of the estimate already done: the estimate's total stays fixed
  // between answers while the time left counts down.
  const progress = () => {
    const answer = eta.eta()
    const left = eta.remaining()
    if (!answer?.remaining || left === undefined) return
    const total = answer.elapsed + answer.remaining
    return Math.min(0.97, Math.max(0.04, 1 - left / total))
  }
  // A permission or question that just arrived knocks twice on the tab.
  const [knock, setKnock] = createSignal(false)
  let knockTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(knockTimer))
  createEffect(
    on(
      state.attention,
      (attention, before) => {
        if (before || !attention) return
        setKnock(true)
        clearTimeout(knockTimer)
        knockTimer = setTimeout(() => setKnock(false), 600)
      },
      { defer: true },
    ),
  )
  // Work that just finished makes the avatar jump once.
  const [landed, setLanded] = createSignal(false)
  let landedTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(landedTimer))
  createEffect(
    on(
      state.loading,
      (loading, before) => {
        if (!before || loading) return
        setLanded(true)
        clearTimeout(landedTimer)
        landedTimer = setTimeout(() => setLanded(false), 600)
      },
      { defer: true },
    ),
  )
  return (
    <SessionTabAvatarView
      project={props.project}
      directory={props.directory}
      revealProjectOnHover={props.revealProjectOnHover}
      unread={state.unread()}
      loading={state.loading()}
      progress={props.progress ? progress() : undefined}
      landed={landed()}
      knock={knock()}
    />
  )
}

export function SessionTabAvatarView(props: {
  project?: LocalProject
  directory: string
  revealProjectOnHover?: boolean
  unread: boolean
  loading: boolean
  /** Share of the estimated work done, 0 to 1; without it a working session shows the spinner. */
  progress?: number
  landed?: boolean
  knock?: boolean
}) {
  const projectAvatar = () => (
    <ProjectAvatar
      fallback={displayName(props.project ?? { worktree: props.directory })}
      src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
      variant={getProjectAvatarVariant(props.project?.icon?.color, props.project?.worktree ?? props.directory)}
      unread={props.unread}
    />
  )
  const idle = () => (
    <span
      class="session-tab-avatar"
      data-landed={props.landed ? "" : undefined}
      data-knock={props.knock ? "" : undefined}
      data-motion="l"
    >
      {projectAvatar()}
    </span>
  )
  return (
    <Show when={props.loading} fallback={idle()}>
      <Show
        when={props.progress}
        fallback={
          <span class="relative block size-4 shrink-0">
            <SessionProgressIndicatorV2
              class={`absolute inset-0 ${props.revealProjectOnHover === false ? "" : "group-hover:invisible"}`}
            />
            <Show when={props.revealProjectOnHover !== false}>
              <span class="invisible absolute inset-0 group-hover:visible">{projectAvatar()}</span>
            </Show>
          </span>
        }
      >
        {(progress) => (
          <span class="session-tab-avatar" data-progress style={{ "--tab-progress": progress() }}>
            {projectAvatar()}
            <span class="session-tab-avatar-arc" aria-hidden="true" />
          </span>
        )}
      </Show>
    </Show>
  )
}
