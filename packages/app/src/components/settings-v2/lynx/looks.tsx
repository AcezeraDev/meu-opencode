import { useTheme } from "@opencode-ai/ui/theme/context"
import { For } from "solid-js"
import { useLanguage } from "@/context/language"
import { CHAT_STYLES, HOME_VIEWS, useLynxPrefs, VARIANTS, type LynxPrefs, type Variant } from "@/context/lynx-prefs"
import { useSettings } from "@/context/settings"
import "./lynx-settings.css"

const SWATCH: Record<Variant, { bg: string; panel: string; text: string }> = {
  noite: { bg: "#0b1226", panel: "#16213f", text: "#e6ebf7" },
  dia: { bg: "#ffffff", panel: "#eef1fb", text: "#0b1226" },
  contraste: { bg: "#000000", panel: "#0b0b12", text: "#ffffff" },
  ciano: { bg: "#06202f", panel: "#0e3a52", text: "#e0fbff" },
}

/**
 * The Lynx Code look: the logo's palette in four variants with a live preview
 * of the app that follows every control, the conversation style, the home view
 * and the extras as big switches with a light.
 */
export function LynxLooks() {
  const language = useLanguage()
  const prefs = useLynxPrefs()
  const settings = useSettings()
  const theme = useTheme()
  const t = (key: string) => language.t(key as never)

  const pick = (variant: Variant) => {
    theme.setColorScheme(variant === "dia" ? "light" : "dark")
    prefs.set("variant", variant)
  }
  const switches: { key: keyof LynxPrefs | "lite" | "diffs"; label: string }[] = [
    { key: "thread", label: t("lynx.chat.extra.thread") },
    { key: "settle", label: t("lynx.chat.extra.settle") },
    { key: "pill", label: t("lynx.chat.extra.pill") },
    { key: "focus", label: t("lynx.set.switch.focus") },
    { key: "replay", label: t("lynx.set.switch.replay") },
    { key: "diffs", label: t("lynx.chat.extra.diffs") },
    { key: "lite", label: t("lynx.set.switch.lite") },
    { key: "settingsWide", label: t("lynx.set.switch.wide") },
  ]
  const on = (key: (typeof switches)[number]["key"]) => {
    if (key === "lite") return settings.appearance.lite()
    if (key === "diffs") return settings.general.editToolPartsExpanded()
    return prefs.get(key) === true
  }
  const flip = (key: (typeof switches)[number]["key"]) => {
    if (key === "lite") return settings.appearance.setLite(!settings.appearance.lite())
    if (key === "diffs") return settings.general.setEditToolPartsExpanded(!settings.general.editToolPartsExpanded())
    prefs.set(key, !prefs.get(key) as never)
  }
  const swatch = () => SWATCH[prefs.get("variant")]

  return (
    <div class="lynx-set">
      <header class="lynx-set-head">
        <h2>{t("lynx.set.tab.looks")}</h2>
        <p>{t("lynx.set.looks.lead")}</p>
      </header>

      <section class="lynx-looks-top">
        <div class="lynx-looks-controls">
          <span class="lynx-set-label">{t("lynx.set.variant")}</span>
          <div class="lynx-variants">
            <For each={VARIANTS}>
              {(variant) => (
                <button
                  type="button"
                  class="lynx-variant"
                  aria-pressed={prefs.get("variant") === variant}
                  onClick={() => pick(variant)}
                >
                  <span class="lynx-variant-mini" style={{ background: SWATCH[variant].bg, color: SWATCH[variant].text }}>
                    <i style={{ background: SWATCH[variant].panel }} />
                    <em style={{ background: SWATCH[variant].text }} />
                    <em style={{ background: "#22d3ee", width: "50%" }} />
                    <span class="lynx-variant-pill" />
                  </span>
                  <b>{t(`lynx.set.variant.${variant}`)}</b>
                </button>
              )}
            </For>
          </div>
          <span class="lynx-set-label">{t("lynx.set.fontSize")}</span>
          <input
            class="lynx-range"
            type="range"
            min="12"
            max="18"
            step="1"
            value={settings.appearance.fontSize()}
            onInput={(event) => settings.appearance.setFontSize(Number(event.currentTarget.value))}
          />
        </div>
        <div class="lynx-preview-app" style={{ background: swatch().bg, color: swatch().text }} aria-hidden="true">
          <div class="lynx-preview-side" style={{ background: swatch().panel }} />
          <div class="lynx-preview-main" style={{ "font-size": `${settings.appearance.fontSize() - 2}px` }} data-style={prefs.get("chatStyle")}>
            <p class="lynx-preview-user">{t("lynx.set.preview.ask")}</p>
            <p class="lynx-preview-answer">{t("lynx.set.preview.answer")}</p>
            <span class="lynx-preview-tool" data-thread={prefs.get("thread") ? "" : undefined}>
              browser_navigate · ead.ufg.br
            </span>
            <span class="lynx-preview-composer" data-pill={prefs.get("pill") ? "" : undefined} style={{ background: swatch().panel }}>
              {t("prompt.placeholder.simple")}
            </span>
          </div>
        </div>
      </section>

      <section>
        <span class="lynx-set-label">{t("lynx.chat.style")}</span>
        <div class="lynx-choice-grid">
          <For each={CHAT_STYLES}>
            {(style) => (
              <button type="button" class="lynx-choice" aria-pressed={prefs.get("chatStyle") === style} onClick={() => prefs.set("chatStyle", style)}>
                <b>{t(`lynx.chat.style.${style}`)}</b>
                <small>{t(`lynx.chat.style.${style}.hint`)}</small>
              </button>
            )}
          </For>
        </div>
      </section>

      <section>
        <span class="lynx-set-label">{t("lynx.set.homeView")}</span>
        <div class="lynx-chips">
          <For each={HOME_VIEWS}>
            {(view) => (
              <button type="button" aria-pressed={prefs.get("homeView") === view} onClick={() => prefs.set("homeView", view)}>
                {t(`lynx.home.view.${view}`)}
              </button>
            )}
          </For>
        </div>
      </section>

      <section>
        <span class="lynx-set-label">{t("lynx.set.switches")}</span>
        <div class="lynx-switches">
          <For each={switches}>
            {(item) => (
              <button type="button" class="lynx-switch" aria-pressed={on(item.key)} onClick={() => flip(item.key)}>
                <i class="lynx-switch-led" />
                <span class="lynx-switch-lever">
                  <b />
                </span>
                <span>{item.label}</span>
              </button>
            )}
          </For>
        </div>
      </section>
    </div>
  )
}
