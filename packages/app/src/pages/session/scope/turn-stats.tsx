import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createMemo, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ClockReadout, Readout } from "./readout"
import { turnFor, turnStats } from "./turn-meter"
import "./scope.css"

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
          <span class="scope-stats-cell">
            <span class="scope-label">{language.t("scope.stats.cost")}</span>
            <span class="scope-readout">$</span>
            <Readout value={value().cost} digits={1} decimals={value().cost < 1 ? 4 : 2} />
          </span>
        </div>
      )}
    </Show>
  )
}
