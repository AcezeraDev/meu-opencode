import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

/**
 * Pause and resume the session, kept in `metadata.paused` so the server reads
 * it live: while paused it starts no new step and no new tool call.
 */
export function createPauseState(input: {
  sessionID: () => string | undefined
  metadata: () => Record<string, unknown> | undefined
  working: () => boolean
  save: (sessionID: string, metadata: Record<string, unknown>) => Promise<unknown>
}) {
  const language = useLanguage()
  // Shows the change right away instead of waiting for the server's session update.
  const [pending, setPending] = createSignal<{ sessionID: string; paused: boolean }>()
  const stored = () => input.metadata()?.["paused"] === true

  createEffect(() => {
    const value = pending()
    if (value && value.sessionID === input.sessionID() && stored() === value.paused) setPending(undefined)
  })

  const paused = createMemo(() => {
    const value = pending()
    if (value && value.sessionID === input.sessionID()) return value.paused
    return stored()
  })

  const set = (next: boolean) => {
    const id = input.sessionID()
    if (!id) return
    setPending({ sessionID: id, paused: next })
    input.save(id, { ...input.metadata(), paused: next }).catch((error: unknown) => {
      setPending(undefined)
      showToast({
        variant: "error",
        title: language.t("prompt.pause.saveFailed"),
        description: error instanceof Error ? error.message : undefined,
      })
    })
  }

  return {
    paused,
    /** Only while the agent works, or while it is paused so it can be resumed. */
    visible: () => Boolean(input.sessionID()) && (input.working() || paused()),
    toggle: () => set(!paused()),
  }
}

export function PauseControl(props: { state: ReturnType<typeof createPauseState> }) {
  const language = useLanguage()
  const label = () => language.t(props.state.paused() ? "prompt.pause.resume" : "prompt.pause.pause")
  return (
    <Show when={props.state.visible()}>
      <TooltipV2
        placement="top"
        gutter={4}
        value={language.t(props.state.paused() ? "prompt.pause.resume.tooltip" : "prompt.pause.pause.tooltip")}
      >
        <ButtonV2
          variant={props.state.paused() ? "outline" : "ghost-muted"}
          size="normal"
          data-action="prompt-pause"
          data-paused={props.state.paused() ? "" : undefined}
          class="min-w-0 justify-start ![font-weight:440]"
          style={{ height: "28px" }}
          aria-pressed={props.state.paused()}
          onClick={() => props.state.toggle()}
        >
          <Icon name={props.state.paused() ? "play" : "pause"} size="small" class="shrink-0" />
          <span class="truncate leading-5">{label()}</span>
        </ButtonV2>
      </TooltipV2>
    </Show>
  )
}
