import { createEffect, createMemo, createSignal } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

// Picked before the session exists; the first message applies it to the new session.
const [draftLook, setDraftLook] = createSignal(false)

/**
 * "Look only" for the browser, kept in `metadata.browserLook` so the server reads
 * it on every tool call: the agent may open, scroll and read pages, but not click,
 * type or submit.
 */
export function createBrowserLookState(input: {
  sessionID: () => string | undefined
  metadata: () => Record<string, unknown> | undefined
  save: (sessionID: string, metadata: Record<string, unknown>) => Promise<unknown>
}) {
  const language = useLanguage()
  // Shows the change right away instead of waiting for the server's session update.
  const [pending, setPending] = createSignal<{ sessionID: string; on: boolean }>()
  const stored = () => input.metadata()?.["browserLook"] === true

  createEffect(() => {
    const value = pending()
    if (value && value.sessionID === input.sessionID() && stored() === value.on) setPending(undefined)
  })

  const on = createMemo(() => {
    const id = input.sessionID()
    if (!id) return draftLook()
    const value = pending()
    if (value?.sessionID === id) return value.on
    return stored()
  })

  const set = (next: boolean) => {
    const id = input.sessionID()
    if (!id) {
      setDraftLook(next)
      return
    }
    setPending({ sessionID: id, on: next })
    input.save(id, { ...input.metadata(), browserLook: next }).catch((error: unknown) => {
      setPending(undefined)
      showToast({
        variant: "error",
        title: language.t("prompt.look.saveFailed"),
        description: error instanceof Error ? error.message : undefined,
      })
    })
  }

  return { on, toggle: () => set(!on()) }
}

export function BrowserLookControl(props: { state: ReturnType<typeof createBrowserLookState> }) {
  const language = useLanguage()
  return (
    <TooltipV2
      placement="top"
      gutter={4}
      value={language.t(props.state.on() ? "prompt.look.on.tooltip" : "prompt.look.off.tooltip")}
    >
      <ButtonV2
        variant={props.state.on() ? "outline" : "ghost-muted"}
        size="normal"
        data-action="prompt-browser-look"
        data-on={props.state.on() ? "" : undefined}
        class="min-w-0 justify-start ![font-weight:440]"
        style={{ height: "28px" }}
        aria-pressed={props.state.on()}
        aria-label={language.t("prompt.look.label")}
        onClick={() => props.state.toggle()}
      >
        <Icon name="eye" size="small" class="shrink-0" />
        <span class="truncate leading-5" classList={{ "sr-only": !props.state.on() }}>
          {language.t("prompt.look.label")}
        </span>
      </ButtonV2>
    </TooltipV2>
  )
}
