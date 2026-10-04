import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"

export type ReplayStep = { index: number; label: string; kind: "user" | "tool" | "error" }

const SPEEDS = [1, 2, 4] as const

/**
 * Plays a session back step by step: a track with a mark for every prompt,
 * tool and error, a play head that walks them in order, and the conversation
 * scrolling to each step as it is reached. Click a mark to jump there.
 */
export function LynxReplay(props: { steps: ReplayStep[]; onJump: (index: number) => void }) {
  const language = useLanguage()
  const [at, setAt] = createSignal(-1)
  const [playing, setPlaying] = createSignal(false)
  const [speed, setSpeed] = createSignal<(typeof SPEEDS)[number]>(1)
  let timer: ReturnType<typeof setTimeout> | undefined

  const go = (position: number) => {
    const step = props.steps[position]
    if (!step) return
    setAt(position)
    props.onJump(step.index)
  }

  const tick = () => {
    clearTimeout(timer)
    if (!playing()) return
    const next = at() + 1
    if (next >= props.steps.length) return setPlaying(false)
    go(next)
    timer = setTimeout(tick, 1400 / speed())
  }

  createEffect(on(playing, (value) => (value ? tick() : clearTimeout(timer)), { defer: true }))
  onCleanup(() => clearTimeout(timer))

  const ratio = (position: number) => (props.steps.length > 1 ? position / (props.steps.length - 1) : 0)
  const current = () => props.steps[at()]

  return (
    <div class="lynx-replay" role="group" aria-label={language.t("lynx.chat.replay")} data-motion="l">
      <button
        type="button"
        class="lynx-replay-play"
        aria-label={playing() ? language.t("lynx.chat.replay.pause") : language.t("lynx.chat.replay.play")}
        onClick={() => {
          if (!playing() && at() >= props.steps.length - 1) setAt(-1)
          setPlaying(!playing())
        }}
      >
        {playing() ? "❚❚" : "▶"}
      </button>
      <div class="lynx-replay-track">
        <For each={props.steps}>
          {(step, position) => (
            <button
              type="button"
              class="lynx-replay-mark"
              data-kind={step.kind}
              data-done={position() <= at() ? "" : undefined}
              style={{ left: `${ratio(position()) * 100}%` }}
              title={step.label}
              aria-label={step.label}
              onClick={() => {
                setPlaying(false)
                go(position())
              }}
            />
          )}
        </For>
        <span class="lynx-replay-head" style={{ left: `${ratio(Math.max(0, at())) * 100}%` }} />
      </div>
      <span class="lynx-replay-label">
        <Show when={current()} fallback={language.t("lynx.chat.replay.steps", { count: props.steps.length })}>
          {(step) => (
            <>
              <b>
                {at() + 1}/{props.steps.length}
              </b>{" "}
              {step().label}
            </>
          )}
        </Show>
      </span>
      <button
        type="button"
        class="lynx-replay-speed"
        onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length])}
      >
        {speed()}×
      </button>
    </div>
  )
}
