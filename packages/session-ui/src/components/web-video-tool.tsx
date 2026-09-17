import type { ErrorKind, Metadata, Phase, Purpose } from "@opencode-ai/core/web-video/types"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { createMemo, Match, Show, Switch } from "solid-js"
import type { ToolProps } from "./message-part"
import "./web-video-tool.css"

/**
 * Asks the host app to put text in the composer. Regenerate and Retry go
 * through the agent like any other request, so the user sees (and confirms)
 * a paid action before it runs instead of it firing from a button.
 */
export const COMPOSER_FILL_EVENT = "opencode:composer-fill"

export type ComposerFillDetail = { text: string }

const PHASE_KEYS = {
  queued: "ui.webVideo.phase.queued",
  processing: "ui.webVideo.phase.processing",
  generating: "ui.webVideo.phase.generating",
  finishing: "ui.webVideo.phase.finishing",
  completed: "ui.webVideo.phase.completed",
  failed: "ui.webVideo.phase.failed",
} as const satisfies Record<Phase, string>

const PURPOSE_KEYS = {
  hero: "ui.webVideo.purpose.hero",
  background: "ui.webVideo.purpose.background",
  scroll: "ui.webVideo.purpose.scroll",
  product: "ui.webVideo.purpose.product",
  abstract: "ui.webVideo.purpose.abstract",
  section: "ui.webVideo.purpose.section",
} as const satisfies Record<Purpose, string>

const ERROR_KEYS = {
  missing_api_key: "ui.webVideo.error.missing_api_key",
  invalid_api_key: "ui.webVideo.error.invalid_api_key",
  insufficient_balance: "ui.webVideo.error.insufficient_balance",
  rate_limited: "ui.webVideo.error.rate_limited",
  timeout: "ui.webVideo.error.timeout",
  generation_failed: "ui.webVideo.error.generation_failed",
  content_policy: "ui.webVideo.error.content_policy",
  network_error: "ui.webVideo.error.network_error",
  provider_unavailable: "ui.webVideo.error.provider_unavailable",
  invalid_model: "ui.webVideo.error.invalid_model",
  unsupported_setting: "ui.webVideo.error.unsupported_setting",
  invalid_attachment: "ui.webVideo.error.invalid_attachment",
  missing_image: "ui.webVideo.error.missing_image",
  interrupted: "ui.webVideo.error.interrupted",
} as const satisfies Record<ErrorKind, string>

function readMetadata(value: Record<string, unknown>) {
  return value.kind === "web-video" ? (value as unknown as Metadata) : undefined
}

function money(value: number) {
  return `$${value.toFixed(value < 1 ? 3 : 2).replace(/0$/, "")}`
}

function requestAgain(text: string) {
  window.dispatchEvent(new CustomEvent<ComposerFillDetail>(COMPOSER_FILL_EVENT, { detail: { text } }))
}

export function WebVideoToolCard(props: ToolProps) {
  const i18n = useI18n()
  const meta = createMemo(() => readMetadata(props.metadata))
  const running = () => props.status === "pending" || props.status === "running"
  const phase = createMemo<Phase>(() => {
    const status = meta()?.status
    if (status) return status
    return running() ? "queued" : "failed"
  })
  const prompt = () => meta()?.prompt ?? (typeof props.input.prompt === "string" ? props.input.prompt : "")
  const title = () => {
    const purpose = meta()?.settings.purpose
    return purpose ? i18n.t(PURPOSE_KEYS[purpose]) : i18n.t("ui.webVideo.title")
  }
  const details = createMemo(() => {
    const value = meta()
    if (!value) return ""
    const settings = value.settings
    return [
      value.modelName,
      settings.preset === "hero-3d" ? i18n.t("ui.webVideo.preset.hero-3d") : undefined,
      settings.preset === "turntable" ? i18n.t("ui.webVideo.preset.turntable") : undefined,
      settings.referenceImage ? i18n.t("ui.webVideo.fromPhoto") : undefined,
      settings.duration ? `${settings.duration}s` : undefined,
      settings.aspectRatio,
      settings.resolution,
      settings.fps ? `${settings.fps} fps` : undefined,
      settings.scrollFriendly ? i18n.t("ui.webVideo.scroll") : undefined,
      settings.loopFriendly ? i18n.t("ui.webVideo.loop") : undefined,
      settings.generateAudio ? i18n.t("ui.webVideo.audio") : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
  })
  const costLabel = () => {
    const value = meta()
    if (value?.cost !== undefined) return `${i18n.t("ui.webVideo.cost")}: ${money(value.cost)}`
    if (value?.estimatedCost !== undefined)
      return `${i18n.t("ui.webVideo.estimatedCost")}: ~${money(value.estimatedCost)}`
    return i18n.t("ui.webVideo.costUnavailable")
  }
  const again = () => requestAgain(`${i18n.t("ui.webVideo.retryInstruction")}\n${JSON.stringify(props.input, null, 2)}`)

  return (
    <div data-component="web-video-card" data-phase={phase()}>
      <Switch>
        <Match when={phase() === "completed" && meta()?.url}>
          {(url) => (
            <>
              <div data-slot="web-video-player">
                <video src={url()} controls preload="metadata" playsinline />
              </div>
              <div data-slot="web-video-body">
                <div data-slot="web-video-heading">
                  <span data-slot="web-video-title">{title()}</span>
                  <span data-slot="web-video-cost">{costLabel()}</span>
                </div>
                <span data-slot="web-video-details">{details()}</span>
                <p data-slot="web-video-prompt">{prompt()}</p>
                <div data-slot="web-video-actions">
                  <button type="button" data-slot="web-video-button" onClick={again}>
                    {i18n.t("ui.webVideo.regenerate")}
                  </button>
                  <a data-slot="web-video-button" href={url()} target="_blank" rel="noopener noreferrer">
                    {i18n.t("ui.webVideo.open")}
                  </a>
                </div>
              </div>
            </>
          )}
        </Match>

        <Match when={phase() === "failed"}>
          <div data-slot="web-video-body">
            <div data-slot="web-video-heading">
              <span data-slot="web-video-title">{i18n.t(ERROR_KEYS[meta()?.error?.kind ?? "generation_failed"])}</span>
            </div>
            <Show when={meta()?.error?.message}>{(message) => <p data-slot="web-video-error">{message()}</p>}</Show>
            <Show when={details()}>
              <span data-slot="web-video-details">{details()}</span>
            </Show>
            <p data-slot="web-video-prompt">{prompt()}</p>
            <div data-slot="web-video-actions">
              <button type="button" data-slot="web-video-button" data-variant="primary" onClick={again}>
                {i18n.t("ui.webVideo.retry")}
              </button>
            </div>
          </div>
        </Match>

        <Match when={true}>
          <div data-slot="web-video-body">
            <div data-slot="web-video-heading">
              <span data-slot="web-video-title">
                <span data-slot="web-video-live" aria-hidden="true" />
                {i18n.t("ui.webVideo.generating")}
              </span>
              <span data-slot="web-video-phase" role="status" aria-live="polite">
                {i18n.t(PHASE_KEYS[phase()])}
              </span>
            </div>
            <p data-slot="web-video-prompt">{prompt()}</p>
            {/* The API reports states, not percentages, so the bar is indeterminate. */}
            <div data-slot="web-video-progress" aria-hidden="true">
              <span />
            </div>
            <Show when={details()}>
              <span data-slot="web-video-details">{details()}</span>
            </Show>
            <span data-slot="web-video-cost">{costLabel()}</span>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
