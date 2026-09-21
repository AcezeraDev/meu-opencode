import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ClockReadout, Readout } from "./readout"
import { createTurnMeter, type TurnStep } from "./turn-meter"
import { createEta, formatRemaining } from "./eta"
import "./scope.css"

/** How long the strip takes to dissolve after the agent stops (matches scope.css). */
const LEAVE_MS = 460
const TRACE_WIDTH = 96
const TRACE_HEIGHT = 18

const TOOL_KEYS: Record<string, string> = {
  read: "scope.tool.read",
  edit: "scope.tool.edit",
  write: "scope.tool.write",
  apply_patch: "scope.tool.patch",
  bash: "scope.tool.shell",
  shell: "scope.tool.shell",
  grep: "scope.tool.search",
  glob: "scope.tool.search",
  list: "scope.tool.search",
  webfetch: "scope.tool.fetch",
  fetch: "scope.tool.fetch",
  websearch: "scope.tool.web",
  task: "scope.tool.task",
  todowrite: "scope.tool.plan",
  generate_web_video: "scope.tool.video",
}

/**
 * Live readouts docked above the composer while the agent works: elapsed time,
 * streaming rate with its trace, the step in progress, steps done and cost so far.
 * When the turn ends it holds its last values and dissolves, handing over to the
 * response summary in the timeline.
 */
export function MeasurementStrip(props: { sessionID?: string; active: boolean }) {
  const language = useLanguage()
  const [mounted, setMounted] = createSignal(props.active)
  const [leaving, setLeaving] = createSignal(false)

  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active) {
          setLeaving(false)
          setMounted(true)
          return
        }
        if (!mounted()) return
        setLeaving(true)
        const timer = setTimeout(() => {
          setMounted(false)
          setLeaving(false)
        }, LEAVE_MS)
        onCleanup(() => clearTimeout(timer))
      },
    ),
  )

  const meter = createTurnMeter({ sessionID: () => props.sessionID, active: () => props.active })
  const eta = createEta({ sessionID: () => props.sessionID, active: () => props.active })

  // What the estimate stands on, so the number can be trusted for what it is.
  const etaHint = () => {
    const current = eta.eta()
    if (!current) return undefined
    if (current.basis === "plan" && current.todos) {
      return language.t("scope.eta.plan", { done: current.todos.done, total: current.todos.total })
    }
    if (current.basis === "history" && current.typical) {
      return language.t("scope.eta.history", { typical: formatRemaining(current.typical).replace("~", ""), runs: current.runs })
    }
    if (current.typical && current.elapsed > current.typical) return language.t("scope.eta.over")
    return language.t("scope.eta.unknown")
  }

  const stepLabel = (step: TurnStep) => {
    if (step.kind === "waiting") return language.t("scope.step.waiting")
    if (step.kind === "thinking") return language.t("scope.step.thinking")
    if (step.kind === "writing") return language.t("scope.step.writing")
    const key = TOOL_KEYS[step.tool]
    const verb = key ? language.t(key as Parameters<typeof language.t>[0]) : step.tool
    return step.target ? `${verb} ${step.target}` : verb
  }

  const points = createMemo(() => {
    const values = meter.trace()
    if (values.length < 2) return ""
    const peak = Math.max(12, ...values)
    const step = TRACE_WIDTH / (values.length - 1)
    return values
      .map(
        (value, index) =>
          `${(index * step).toFixed(1)},${(TRACE_HEIGHT - 2 - (value / peak) * (TRACE_HEIGHT - 4)).toFixed(1)}`,
      )
      .join(" ")
  })

  return (
    <Show when={mounted()}>
      <div class="scope-strip" data-leaving={leaving() ? "" : undefined} aria-label={stepLabel(meter.step())}>
        <span class="scope-strip-channel" data-chroma>
          <span class="scope-strip-led" aria-hidden="true" />
          CH1
        </span>

        <span class="scope-strip-cell">
          <span class="scope-label">{language.t("scope.strip.time")}</span>
          <ClockReadout ms={meter.elapsed()} />
        </span>

        <span class="scope-strip-cell" title={etaHint()}>
          <span class="scope-label">{language.t("scope.strip.eta")}</span>
          <span class="scope-readout">
            {eta.remaining() !== undefined ? formatRemaining(eta.remaining()!) : "—"}
          </span>
        </span>

        <span class="scope-strip-cell">
          <span class="scope-label">{language.t("scope.strip.rate")}</span>
          <Readout value={meter.rate()} digits={3} />
          <span class="scope-strip-unit">tok/s</span>
        </span>

        <span class="scope-strip-trace" data-chroma aria-hidden="true">
          <svg viewBox={`0 0 ${TRACE_WIDTH} ${TRACE_HEIGHT}`} width={TRACE_WIDTH} height={TRACE_HEIGHT}>
            <line x1="0" y1={TRACE_HEIGHT / 2} x2={TRACE_WIDTH} y2={TRACE_HEIGHT / 2} class="scope-strip-trace-axis" />
            <polyline points={points()} />
          </svg>
        </span>

        <span class="scope-strip-cell scope-strip-step">
          <span class="scope-label">{language.t("scope.strip.step")}</span>
          <Show when={stepLabel(meter.step())} keyed>
            {(label) => <span class="scope-strip-step-text">{label}</span>}
          </Show>
        </span>

        <span class="scope-strip-cell scope-strip-optional">
          <span class="scope-label">{language.t("scope.strip.steps")}</span>
          <Readout value={meter.steps()} digits={3} />
        </span>

        <span class="scope-strip-cell">
          <span class="scope-label">{language.t("scope.strip.cost")}</span>
          <span class="scope-readout">$</span>
          <Readout value={meter.cost()} digits={1} decimals={meter.cost() < 1 ? 4 : 2} />
        </span>
      </div>
    </Show>
  )
}
