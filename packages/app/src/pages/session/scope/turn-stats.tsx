import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createMemo, Show } from "solid-js"
import { announceSpend } from "@/components/day-spend"
import { createUsdBrlRate } from "@/components/exchange-rate"
import { useLanguage } from "@/context/language"
import { ClockReadout, Readout } from "./readout"
import { turnFor, turnStats } from "./turn-meter"
import "./scope.css"

// Turns whose cost already flew to today's spend; a row the timeline mounts
// again while it is still fresh must not send it twice.
const announced = new Set<string>()

/**
 * The measurement footer under a finished response: how long it took, tools used,
 * files changed, output and speed, and cost. A response that just finished settles
 * in (the live strip above the composer dissolves into it).
 */
export function TurnStats(props: {
  messages: Message[]
  userMessageID: string
  parts: (messageID: string) => Part[]
  fresh: boolean
}) {
  const language = useLanguage()
  const rate = createUsdBrlRate()
  // The taxi meter speaks the person's money: reais when the app is in Portuguese.
  const brl = () => (language.intl().toLowerCase().startsWith("pt") ? rate() : undefined)
  const stats = createMemo(() => {
    const turn = turnFor(props.messages, props.userMessageID)
    return turn && turn.assistants.length > 0 ? turnStats(turn, props.parts) : undefined
  })

  return (
    <Show when={stats()}>
      {(value) => (
        <div
          class="scope-stats"
          data-fresh={props.fresh ? "" : undefined}
          role="group"
          aria-label={language.t("scope.stats.ariaLabel")}
        >
          <Show when={props.fresh}>
            <span class="scope-stats-sweep" data-chroma aria-hidden="true">
              <span />
            </span>
          </Show>
          <span class="scope-stats-cell">
            <span class="scope-label">{language.t("scope.stats.duration")}</span>
            <ClockReadout ms={value().duration} />
          </span>
          <span class="scope-stats-cell">
            <span class="scope-label">{language.t("scope.stats.tools")}</span>
            <Readout value={value().tools} digits={3} />
          </span>
          <Show when={value().files > 0}>
            <span class="scope-stats-cell">
              <span class="scope-label">{language.t("scope.stats.files")}</span>
              <Readout value={value().files} digits={3} />
            </span>
          </Show>
          <span class="scope-stats-cell">
            <span class="scope-label">{language.t("scope.stats.output")}</span>
            <Readout value={value().output} digits={5} />
            <span class="scope-stats-unit">tok</span>
          </span>
          <Show when={value().rate > 0}>
            <span class="scope-stats-cell">
              <span class="scope-label">{language.t("scope.stats.rate")}</span>
              <Readout value={value().rate} digits={3} />
              <span class="scope-stats-unit">tok/s</span>
            </span>
          </Show>
          <span
            class="scope-stats-cell"
            ref={(el) => {
              // A response that just finished sends its cost to today's spend.
              if (!props.fresh || !(value().cost > 0) || announced.has(props.userMessageID)) return
              announced.add(props.userMessageID)
              requestAnimationFrame(() => announceSpend(value().cost, el.getBoundingClientRect()))
            }}
          >
            <span class="scope-label">{language.t("scope.stats.cost")}</span>
            <span class="scope-readout">{brl() ? "R$" : "$"}</span>
            <Readout
              value={value().cost * (brl() ?? 1)}
              digits={1}
              decimals={value().cost * (brl() ?? 1) < 1 ? 3 : 2}
            />
          </span>
        </div>
      )}
    </Show>
  )
}
