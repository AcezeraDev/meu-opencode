import { createSignal, For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"

import { useCommand } from "@/context/command"
import { DESKTOP_MENU, desktopMenuVisible, type DesktopMenuAction, type DesktopMenuEntry } from "@/desktop-menu"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import "./windows-app-menu.css"

const MENU_ICONS: Record<string, IconProps["name"]> = {
  file: "folder",
  edit: "pencil-line",
  view: "eye",
  go: "arrow-right",
  window: "window-cursor",
  help: "help",
}

/**
 * Submenus open flush against the category column so both read as one panel.
 * The sub content's left edge sits `gutter` px past the trigger's right edge,
 * which is the root's padding plus its border, minus one so the borders overlap.
 */
const PANEL_PADDING = 6
const PANEL_BORDER = 1
const SUB_GUTTER = PANEL_PADDING + PANEL_BORDER - 1
/** A submenu opening this soon after another closed is a switch, not a fresh open. */
const SWITCH_WINDOW_MS = 220

const OVERHANG_TOLERANCE = 6

/** "Ctrl+Shift+N" → Ctrl, Shift, N; "Ctrl++" keeps its plus key. */
const acceleratorKeys = (value: string) => value.split(/\+(?!$)/)

/**
 * A single highlight that glides between rows instead of each row lighting up on
 * its own. Follows the pointer and keyboard focus (Kobalte focuses the highlighted item).
 */
function glide(panel: HTMLElement, keep: () => boolean) {
  const move = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return
    const row = target.closest<HTMLElement>("[data-glide-row]")
    if (!row || !panel.contains(row) || row.hasAttribute("data-disabled")) return
    // The first placement jumps; only later moves glide.
    if (!panel.hasAttribute("data-glide")) {
      panel.setAttribute("data-glide-instant", "")
      requestAnimationFrame(() => requestAnimationFrame(() => panel.removeAttribute("data-glide-instant")))
    }
    panel.style.setProperty("--glide-y", `${row.offsetTop}px`)
    panel.style.setProperty("--glide-h", `${row.offsetHeight}px`)
    panel.setAttribute("data-glide", "")
  }
  panel.addEventListener("focusin", (event) => move(event.target))
  panel.addEventListener("pointermove", (event) => move(event.target))
  panel.addEventListener("pointerleave", () => {
    if (keep() || panel.contains(document.activeElement)) return
    panel.removeAttribute("data-glide")
  })
}

export function WindowsAppMenu(props: {
  command: ReturnType<typeof useCommand>
  platform: ReturnType<typeof usePlatform>
  variant?: "legacy" | "v2"
}) {
  let lastFocused: HTMLElement | undefined
  const language = useLanguage()
  const [openSub, setOpenSub] = createSignal<string>()
  const [switching, setSwitching] = createSignal(false)
  const [geometry, setGeometry] = createStore({ height: 0, offsets: {} as Record<string, number> })
  const [rootPanel, setRootPanel] = createSignal<HTMLElement>()
  let closedAt = 0

  const rememberFocus = () => {
    const active = document.activeElement
    lastFocused = active instanceof HTMLElement ? active : undefined
  }
  const commandDisabled = (id: string) => {
    const option = props.command.options.find((option) => option.id === id)
    if (!option) return true
    return option.disabled ?? false
  }
  const runCommand = (id: string) => {
    if (commandDisabled(id)) return
    props.command.trigger(id)
  }
  const runAction = (action: DesktopMenuAction) => {
    if (action.startsWith("edit.") && lastFocused?.isConnected) lastFocused.focus({ preventScroll: true })
    void props.platform.runDesktopMenuAction?.(action)
  }
  const runEntry = (entry: DesktopMenuEntry) => {
    if (entry.type === "separator") return
    if (entry.command) {
      runCommand(entry.command)
      return
    }
    if (entry.action) {
      runAction(entry.action)
      return
    }
    if (entry.href) props.platform.openExternal(entry.href)
  }
  const entryKeys = (entry: DesktopMenuEntry) => {
    if (entry.type === "separator") return []
    if (entry.command) return props.command.keybindParts(entry.command)
    const accelerator = entry.accelerator?.windows
    return accelerator ? acceleratorKeys(accelerator) : []
  }

  const onSubOpenChange = (id: string, open: boolean) => {
    if (open) {
      setSwitching(openSub() !== undefined || performance.now() - closedAt < SWITCH_WINDOW_MS)
      setOpenSub(id)
      return
    }
    if (openSub() !== id) return
    closedAt = performance.now()
    setOpenSub(undefined)
  }

  // Row offsets let each submenu shift up to the panel's top edge.
  const measure = (panel: HTMLElement) => {
    setRootPanel(panel)
    glide(panel, () => openSub() !== undefined)
    requestAnimationFrame(() => {
      const offsets = Object.fromEntries(
        Array.from(panel.querySelectorAll<HTMLElement>("[data-menu-id]")).map((row) => [
          row.dataset.menuId ?? "",
          row.offsetTop + panel.clientTop,
        ]),
      )
      setGeometry({ height: panel.offsetHeight, offsets })
    })
  }

  const menus = () => DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, "windows"))

  return (
    <DropdownMenu
      gutter={4}
      modal={false}
      placement="bottom-start"
      onOpenChange={(open) => {
        if (!open) setOpenSub(undefined)
      }}
    >
      {props.variant === "v2" ? (
        <div
          data-component="desktop-icon-button"
          class="flex h-7 w-9 shrink-0 items-center justify-center rounded-[6px] px-1"
        >
          <DropdownMenu.Trigger
            as={IconButtonV2}
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="menu" />}
            aria-label={language.t("desktop.menu.ariaLabel")}
            onPointerDown={rememberFocus}
            onKeyDown={rememberFocus}
          />
        </div>
      ) : (
        <DropdownMenu.Trigger
          as={IconButton}
          icon="menu"
          variant="ghost"
          class="titlebar-icon rounded-md shrink-0"
          aria-label={language.t("desktop.menu.ariaLabel")}
          onPointerDown={rememberFocus}
          onKeyDown={rememberFocus}
        />
      )}
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={measure}
          class="desktop-app-menu"
          data-attached={openSub() ? "" : undefined}
          style={{ "--panel-padding": `${PANEL_PADDING}px` }}
        >
          <span class="desktop-app-menu-glide" aria-hidden="true" />
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel class="desktop-app-menu-heading">
              <span class="desktop-app-menu-wordmark">OpenCode</span>
              <Show when={props.platform.version}>
                {(version) => <span class="desktop-app-menu-version">v{version()}</span>}
              </Show>
            </DropdownMenu.GroupLabel>
            <For each={menus()}>
              {(menu, index) => (
                <DesktopMenuSubmenu
                  id={menu.id}
                  index={index()}
                  label={language.t(menu.labelKey)}
                  icon={MENU_ICONS[menu.id] ?? "chevron-right"}
                  shift={-(geometry.offsets[menu.id] ?? 0)}
                  minHeight={geometry.height}
                  switching={switching()}
                  root={rootPanel}
                  onOpenChange={(open) => onSubOpenChange(menu.id, open)}
                >
                  {menu.items
                    ?.filter((entry) => desktopMenuVisible(entry, "windows"))
                    .map((entry, position) =>
                      entry.type === "separator" ? (
                        <DropdownMenu.Separator />
                      ) : (
                        <DesktopMenuItem
                          index={position}
                          label={entry.labelKey ? language.t(entry.labelKey) : ""}
                          keys={entryKeys(entry)}
                          disabled={entry.command ? commandDisabled(entry.command) : false}
                          onSelect={() => runEntry(entry)}
                        />
                      ),
                    )}
                </DesktopMenuSubmenu>
              )}
            </For>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

function DesktopMenuSubmenu(props: {
  id: string
  index: number
  label: string
  icon: IconProps["name"]
  shift: number
  minHeight: number
  switching: boolean
  root: () => HTMLElement | undefined
  onOpenChange: (open: boolean) => void
  children: JSX.Element
}) {
  // A column taller than the categories (or pushed up by a short window) sticks out
  // past the seam; those corners get rounded again.
  const markOverhang = (panel: HTMLElement) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const root = props.root()?.getBoundingClientRect()
        if (!root) return
        const box = panel.getBoundingClientRect()
        // The tolerance absorbs the few pixels the swap animation is still moving.
        panel.toggleAttribute("data-overhang-top", box.top < root.top - OVERHANG_TOLERANCE)
        panel.toggleAttribute("data-overhang-bottom", box.bottom > root.bottom + OVERHANG_TOLERANCE)
      }),
    )
  }

  return (
    <DropdownMenu.Sub gutter={SUB_GUTTER} shift={props.shift} onOpenChange={props.onOpenChange}>
      <DropdownMenu.SubTrigger data-menu-id={props.id} data-glide-row style={{ "--i": props.index }}>
        <span class="desktop-app-menu-tile" aria-hidden="true">
          <Icon name={props.icon} size="small" />
        </span>
        <span data-slot="dropdown-menu-item-label">{props.label}</span>
        <span data-slot="desktop-app-menu-chevron">
          <Icon name="chevron-right" size="small" />
        </span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          ref={(panel: HTMLElement) => {
            glide(panel, () => false)
            markOverhang(panel)
          }}
          class="desktop-app-menu desktop-app-menu-items"
          data-switch={props.switching ? "" : undefined}
          style={{ "min-height": props.minHeight ? `${props.minHeight}px` : undefined }}
        >
          <span class="desktop-app-menu-glide" aria-hidden="true" />
          {props.children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

function DesktopMenuItem(props: {
  index: number
  label: string
  keys: string[]
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <DropdownMenu.Item
      disabled={props.disabled}
      onSelect={props.onSelect}
      data-glide-row
      style={{ "--i": props.index }}
    >
      <DropdownMenu.ItemLabel>{props.label}</DropdownMenu.ItemLabel>
      <Show when={props.keys.length > 0}>
        <KeybindV2 keys={props.keys} variant="neutral" class="desktop-app-menu-keys" />
      </Show>
    </DropdownMenu.Item>
  )
}
