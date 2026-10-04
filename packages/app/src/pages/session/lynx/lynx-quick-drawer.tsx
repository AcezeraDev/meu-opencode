import { useTheme } from "@opencode-ai/ui/theme/context"
import { For, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { CHAT_STYLES, useLynxPrefs, VARIANTS, type Variant } from "@/context/lynx-prefs"
import { useSettings } from "@/context/settings"

/**
 * Quick settings in a drawer over the session: the conversation style, the
 * extras as switches and the palette, changed without leaving the work, with
 * the effect visible right beside it.
 */
export function LynxQuickDrawer(props: { onClose: () => void }) {
  const language = useLanguage()
  const prefs = useLynxPrefs()
  const settings = useSettings()
  const theme = useTheme()
  const command = useCommand()
  const t = (key: string) => language.t(key as never)

  const extras = [
    { key: "thread", label: t("lynx.chat.extra.thread") },
    { key: "settle", label: t("lynx.chat.extra.settle") },
    { key: "pill", label: t("lynx.chat.extra.pill") },
    { key: "focus", label: t("lynx.set.switch.focus") },
    { key: "replay", label: t("lynx.set.switch.replay") },
    { key: "diffs", label: t("lynx.chat.extra.diffs") },
  ] as const
  const on = (key: (typeof extras)[number]["key"]) =>
    key === "diffs" ? settings.general.editToolPartsExpanded() : prefs.get(key) === true
  const flip = (key: (typeof extras)[number]["key"]) => {
    if (key === "diffs") return settings.general.setEditToolPartsExpanded(!settings.general.editToolPartsExpanded())
    prefs.set(key, !prefs.get(key))
  }
  const pick = (variant: Variant) => {
    theme.setColorScheme(variant === "dia" ? "light" : "dark")
    prefs.set("variant", variant)
  }

  const escape = (event: KeyboardEvent) => event.key === "Escape" && props.onClose()
  onMount(() => document.addEventListener("keydown", escape))
  onCleanup(() => document.removeEventListener("keydown", escape))

  return (
    <Portal>
      <div class="lynx-drawer-scrim" onClick={props.onClose} />
      <aside class="lynx-drawer" role="dialog" aria-label={t("lynx.quick.title")} data-motion="l">
        <header>
          <b>{t("lynx.quick.title")}</b>
          <button type="button" aria-label={t("common.close")} onClick={props.onClose}>
            ✕
          </button>
        </header>
        <span class="lynx-drawer-label">{t("lynx.chat.style")}</span>
        <div class="lynx-drawer-list">
          <For each={CHAT_STYLES}>
            {(style) => (
              <button type="button" aria-pressed={prefs.get("chatStyle") === style} onClick={() => prefs.set("chatStyle", style)}>
                <b>{t(`lynx.chat.style.${style}`)}</b>
                <small>{t(`lynx.chat.style.${style}.hint`)}</small>
              </button>
            )}
          </For>
        </div>
        <span class="lynx-drawer-label">{t("lynx.chat.extras")}</span>
        <For each={extras}>
          {(item) => (
            <button type="button" class="lynx-drawer-toggle" aria-pressed={on(item.key)} onClick={() => flip(item.key)}>
              <span>{item.label}</span>
              <i />
            </button>
          )}
        </For>
        <span class="lynx-drawer-label">{t("lynx.set.variant")}</span>
        <div class="lynx-drawer-variants">
          <For each={VARIANTS}>
            {(variant) => (
              <button type="button" data-variant={variant} aria-pressed={prefs.get("variant") === variant} onClick={() => pick(variant)}>
                {t(`lynx.set.variant.${variant}`)}
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="lynx-drawer-all"
          onClick={() => {
            props.onClose()
            command.trigger("settings.open")
          }}
        >
          {t("lynx.quick.all")} ›
        </button>
      </aside>
    </Portal>
  )
}
