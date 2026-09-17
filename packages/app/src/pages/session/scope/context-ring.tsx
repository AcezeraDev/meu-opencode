import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { openSessionContext } from "@/components/session-context-usage"
import { getSessionContext } from "@/components/session/session-context-metrics"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import "./scope.css"

const RADIUS = 6.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Context fill at the composer: a ring that reads how much of the model's window the
 * session uses, turning amber and red as it fills, with compaction one click away.
 */
export function ContextRing() {
  const sync = useSync()
  const sdk = useSDK()
  const layout = useLayout()
  const command = useCommand()
  const language = useLanguage()
  const providers = useProviders(() => sdk().directory)
  const { params, tabs, view } = useSessionLayout()
  const [open, setOpen] = createSignal(false)
  const [anchor, setAnchor] = createSignal({ left: 0, bottom: 0 })
  let root: HTMLDivElement | undefined
  let panel: HTMLDivElement | undefined

  const context = createMemo(() =>
    params.id ? getSessionContext(sync().data.message[params.id] ?? [], [...providers.all().values()]) : undefined,
  )
  const usage = () => context()?.usage ?? 0
  const level = () => (usage() >= 90 ? "critical" : usage() >= 70 ? "high" : "normal")
  const number = (value: number | undefined) => (value ?? 0).toLocaleString(language.intl())

  // The composer clips its overflow, so the panel renders in a portal, placed above the ring.
  const toggle = () => {
    const box = root?.getBoundingClientRect()
    if (box) setAnchor({ left: box.left, bottom: window.innerHeight - box.top + 8 })
    setOpen((value) => !value)
  }
  const close = (event: PointerEvent) => {
    const target = event.target as Node
    if (root?.contains(target) || panel?.contains(target)) return
    setOpen(false)
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") setOpen(false)
  }
  document.addEventListener("pointerdown", close)
  document.addEventListener("keydown", escape)
  onCleanup(() => {
    document.removeEventListener("pointerdown", close)
    document.removeEventListener("keydown", escape)
  })

  return (
    <Show when={params.id && context()?.usage !== null && context()}>
      <div class="scope-ring" ref={root} data-level={level()}>
        <button
          type="button"
          class="scope-ring-button"
          aria-expanded={open()}
          aria-label={language.t("scope.context.label", { percent: usage() })}
          onClick={toggle}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-chroma>
            <circle cx="8" cy="8" r={RADIUS} class="scope-ring-track" />
            <circle
              cx="8"
              cy="8"
              r={RADIUS}
              class="scope-ring-fill"
              stroke-dasharray={`${(Math.min(100, usage()) / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            />
          </svg>
          <span class="scope-readout">{usage()}%</span>
        </button>
        <Show when={open()}>
          <Portal>
            <div
              ref={panel}
              class="scope-ring-panel"
              data-level={level()}
              role="dialog"
              aria-label={language.t("scope.context.label", { percent: usage() })}
              style={{ left: `${anchor().left}px`, bottom: `${anchor().bottom}px` }}
            >
              <div class="scope-ring-panel-top">
                <span class="scope-label">{language.t("context.meter.title")}</span>
                <span class="scope-readout scope-ring-percent">{usage()}%</span>
              </div>
              <div class="scope-ring-meter" aria-hidden="true">
                <span style={{ transform: `scaleX(${Math.min(100, usage()) / 100})` }} data-chroma />
              </div>
              <p class="scope-ring-usage">
                {language.t("scope.context.usage", {
                  used: number(context()?.total),
                  limit: number(context()?.limit),
                })}
              </p>
              <p class="scope-ring-hint">{language.t("scope.context.hint")}</p>
              <div class="scope-ring-actions">
                <button
                  type="button"
                  class="scope-ring-action"
                  data-primary
                  data-chroma
                  onClick={() => {
                    setOpen(false)
                    command.trigger("session.compact")
                  }}
                >
                  {language.t("scope.context.compact")}
                </button>
                <button
                  type="button"
                  class="scope-ring-action"
                  onClick={() => {
                    setOpen(false)
                    openSessionContext({ view: view(), layout, tabs: tabs() })
                  }}
                >
                  {language.t("scope.context.open")}
                </button>
              </div>
            </div>
          </Portal>
        </Show>
      </div>
    </Show>
  )
}
