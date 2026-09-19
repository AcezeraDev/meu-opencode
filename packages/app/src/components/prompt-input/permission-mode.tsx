import { createEffect, createMemo, createSignal, For } from "solid-js"
import { PermissionV1 } from "@opencode-ai/schema/permission-v1"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import "./permission-mode.css"

export type PermissionMode = PermissionV1.Mode
export const PERMISSION_MODES = PermissionV1.Mode.literals

// Picked before the session exists; the first message applies it to the new session.
const [draftMode, setDraftMode] = createSignal<PermissionMode>("default")

function parseMode(value: unknown) {
  return PERMISSION_MODES.find((mode) => mode === value)
}

/**
 * Sends focus back to the prompt when a composer menu closes, instead of to its
 * trigger, whose tooltip would otherwise linger. Leaves it alone when the click
 * that closed the menu already focused something else, such as another menu.
 */
export function returnFocus(event: Event, restore: (() => void) | undefined) {
  if (!restore) return
  event.preventDefault()
  const active = document.activeElement
  const menu = event.currentTarget instanceof Element ? event.currentTarget : undefined
  if (active && active !== document.body && !menu?.contains(active)) return
  restore()
}

/** The session's permission mode, kept in `metadata.permissionMode` so the server can read it. */
export function createPermissionModeState(input: {
  sessionID: () => string | undefined
  metadata: () => Record<string, unknown> | undefined
  save: (sessionID: string, metadata: Record<string, unknown>) => Promise<unknown>
}) {
  const language = useLanguage()
  // Shows the pick right away instead of waiting for the server's session update.
  const [pending, setPending] = createSignal<{ sessionID: string; mode: PermissionMode }>()
  const stored = () => parseMode(input.metadata()?.["permissionMode"])

  createEffect(() => {
    const value = pending()
    if (value && value.sessionID === input.sessionID() && stored() === value.mode) setPending(undefined)
  })

  const current = createMemo<PermissionMode>(() => {
    const id = input.sessionID()
    if (!id) return draftMode()
    const value = pending()
    if (value?.sessionID === id) return value.mode
    return stored() ?? "default"
  })

  const set = (mode: PermissionMode) => {
    const id = input.sessionID()
    if (!id) {
      setDraftMode(mode)
      return
    }
    setPending({ sessionID: id, mode })
    input.save(id, { ...input.metadata(), permissionMode: mode }).catch((error: unknown) => {
      setPending(undefined)
      showToast({
        variant: "error",
        title: language.t("ui.permissionMode.saveFailed"),
        description: error instanceof Error ? error.message : undefined,
      })
    })
  }

  return { current, set }
}

export function PermissionModeControl(props: {
  current: PermissionMode
  onSelect: (mode: PermissionMode) => void
  onClose?: () => void
}) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const label = (mode: PermissionMode) => language.t(`ui.permissionMode.${mode}` as Parameters<typeof language.t>[0])
  const description = (mode: PermissionMode) =>
    language.t(`ui.permissionMode.${mode}.description` as Parameters<typeof language.t>[0])
  const pick = (mode: PermissionMode) => {
    setOpen(false)
    if (mode !== props.current) props.onSelect(mode)
  }

  return (
    <TooltipV2 placement="top" gutter={4} value={language.t("ui.permissionMode.tooltip")} inactive={open()}>
      <MenuV2
        open={open()}
        onOpenChange={setOpen}
        gutter={6}
        modal={false}
        placement="top-start"
      >
        <MenuV2.Trigger
          as={ButtonV2}
          variant="ghost-muted"
          size="normal"
          data-action="prompt-permission-mode"
          data-permission-mode={props.current}
          class="min-w-0 max-w-[200px] justify-start ![font-weight:440]"
          style={{ height: "28px" }}
          aria-label={`${language.t("ui.permissionMode.tooltip")}: ${label(props.current)}`}
        >
          <Icon name="shield" size="small" class="shrink-0" />
          <span class="truncate leading-5">{label(props.current)}</span>
          <span class="-ms-0.5 -me-1 flex shrink-0">
            <IconV2 name="chevron-down" />
          </span>
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content
            data-slot="permission-mode-menu"
            onCloseAutoFocus={(event: Event) => returnFocus(event, props.onClose)}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return
              const mode = PERMISSION_MODES[Number(event.key) - 1]
              if (!mode) return
              event.preventDefault()
              pick(mode)
            }}
          >
            <MenuV2.Group>
              <MenuV2.GroupLabel>{language.t("ui.permissionMode.title")}</MenuV2.GroupLabel>
              <MenuV2.RadioGroup value={props.current} onChange={(value) => pick(value as PermissionMode)}>
                <For each={PERMISSION_MODES}>
                  {(mode, index) => (
                    <MenuV2.RadioItem
                      value={mode}
                      data-slot="permission-mode-item"
                      data-permission-mode={mode}
                      shortcut={String(index() + 1)}
                      closeOnSelect
                    >
                      <span data-slot="permission-mode-text">
                        <span data-slot="permission-mode-label">{label(mode)}</span>
                        <span data-slot="permission-mode-description">{description(mode)}</span>
                      </span>
                    </MenuV2.RadioItem>
                  )}
                </For>
              </MenuV2.RadioGroup>
            </MenuV2.Group>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </TooltipV2>
  )
}
