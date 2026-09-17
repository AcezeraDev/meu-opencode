import type { ToolPart } from "@opencode-ai/sdk/v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import "./session-trail.css"

const INPUT_PREVIEW_LIMIT = 600

const STATUS_KEYS = {
  pending: "session.trail.status.pending",
  running: "session.trail.status.running",
  completed: "session.trail.status.completed",
  error: "session.trail.status.error",
} as const

function stepSummary(step: ToolPart) {
  const input = step.state.input
  const value = input.command ?? input.filePath ?? input.pattern ?? input.url ?? input.path ?? input.query
  if (typeof value === "string") return value
  return JSON.stringify(input).slice(0, INPUT_PREVIEW_LIMIT)
}

function stepTitle(step: ToolPart) {
  if (step.state.status === "completed" || step.state.status === "running") return step.state.title || step.tool
  return step.tool
}

function stepDuration(step: ToolPart) {
  if (step.state.status !== "completed" && step.state.status !== "error") return
  const seconds = (step.state.time.end - step.state.time.start) / 1000
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(1)} s`
}

function stepOutput(step: ToolPart) {
  if (step.state.status === "completed") return step.state.output
  if (step.state.status === "error") return step.state.error
  return
}

/** Trail mode: the agent's tool calls as an ordered run, with the selected step's I/O beside it. */
export function SessionTrail(props: { sessionID: string }) {
  const sync = useSync()
  const language = useLanguage()
  const [selected, setSelected] = createSignal<string>()

  const steps = createMemo(() =>
    (sync().data.message[props.sessionID] ?? [])
      .filter((message) => message.role === "assistant")
      .flatMap((message) =>
        (sync().data.part[message.id] ?? []).filter((part): part is ToolPart => part.type === "tool"),
      ),
  )

  // Follow the live step unless the user picked one explicitly.
  const active = createMemo(() => {
    const list = steps()
    return (
      list.find((step) => step.id === selected()) ??
      [...list].reverse().find((step) => step.state.status === "running") ??
      list[list.length - 1]
    )
  })

  const statusLabel = (step: ToolPart) => language.t(STATUS_KEYS[step.state.status])

  return (
    <div class="session-trail">
      <Show
        when={steps().length > 0}
        fallback={
          <div class="session-trail-empty">
            <span class="session-trail-empty-icon">
              <Icon name="status" />
            </span>
            <p>{language.t("session.trail.empty")}</p>
          </div>
        }
      >
        <section class="session-trail-steps" aria-label={language.t("session.trail.title")}>
          <header class="session-trail-header">
            <span>{language.t("session.trail.title")}</span>
            <span class="session-trail-count">{language.t("session.trail.count", { count: steps().length })}</span>
          </header>
          <ol class="session-trail-list">
            <For each={steps()}>
              {(step) => (
                <li class="session-trail-step" data-status={step.state.status}>
                  <span class="session-trail-node" aria-hidden="true">
                    <Show when={step.state.status === "completed"}>
                      <Icon name="check" size="small" />
                    </Show>
                  </span>
                  <button
                    type="button"
                    class="session-trail-step-button"
                    data-active={active()?.id === step.id ? "" : undefined}
                    aria-current={active()?.id === step.id ? "step" : undefined}
                    onClick={() => setSelected(step.id)}
                  >
                    <span class="session-trail-step-title">{stepTitle(step)}</span>
                    <span class="session-trail-step-meta">
                      {step.tool}
                      <Show when={stepDuration(step)}>{(duration) => <> · {duration()}</>}</Show>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ol>
        </section>

        <Show when={active()} keyed>
          {(step) => (
            <section class="session-trail-detail" data-status={step.state.status}>
              <header class="session-trail-detail-header">
                <span class="session-trail-status-dot" aria-hidden="true" />
                <span class="session-trail-detail-title">{stepTitle(step)}</span>
                <span class="session-trail-detail-status">{statusLabel(step)}</span>
              </header>
              <div class="session-trail-block">
                <span class="session-trail-label">{language.t("session.trail.input")}</span>
                <pre class="session-trail-code">{stepSummary(step)}</pre>
              </div>
              <Show when={stepOutput(step)}>
                {(output) => (
                  <div class="session-trail-block session-trail-block-grow">
                    <span class="session-trail-label">{language.t("session.trail.output")}</span>
                    <pre class="session-trail-code session-trail-output">{output()}</pre>
                  </div>
                )}
              </Show>
            </section>
          )}
        </Show>
      </Show>
    </div>
  )
}
