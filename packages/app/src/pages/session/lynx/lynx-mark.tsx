import { createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"

type Mood = "idle" | "code" | "browser" | "error"

const CODE = ["const lynx = agente()", "await abrir('brave')", "ler('src/app.tsx')", "rodar('bun test')", "git commit -m feat", "escrever(texto)"]

/**
 * The logo as the session's state, beside its title: code running through the
 * circle while Lynx programs, the cursor when she is in the browser (turning
 * back into the prompt when she leaves it), a stumble with a red ring on an
 * error, the prompt shooting forward when a message is sent, and the steady
 * blink when she is waiting.
 */
export function LynxMark(props: { sessionID?: string }) {
  const sync = useSync()
  const language = useLanguage()
  const id = createUniqueId()
  const [beat, setBeat] = createSignal<"send" | "morph" | "stumble">()
  let timer: ReturnType<typeof setTimeout> | undefined

  const play = (name: "send" | "morph" | "stumble", ms: number) => {
    clearTimeout(timer)
    setBeat(undefined)
    requestAnimationFrame(() => setBeat(name))
    timer = setTimeout(() => setBeat(undefined), ms)
  }

  const mood = createMemo<Mood>(() => {
    const session = props.sessionID
    if (!session) return "idle"
    const messages = sync().data.message[session] ?? []
    const last = messages.at(-1)
    if (last?.role === "assistant" && last.error) return "error"
    if ((sync().data.session_status[session]?.type ?? "idle") === "idle") return "idle"
    const parts = last ? (sync().data.part[last.id] ?? []) : []
    const tool = parts.findLast((part) => part.type === "tool")
    return tool?.type === "tool" && tool.tool.startsWith("browser_") ? "browser" : "code"
  })

  createEffect(
    on(
      mood,
      (now, before) => {
        if (now === "error") play("stumble", 900)
        if (before === "browser" && now !== "browser") play("morph", 1100)
      },
      { defer: true },
    ),
  )

  // Sending a message fires the prompt forward, from wherever it was sent.
  const sent = (event: Event) => {
    if ((event.target as Element)?.closest?.('[data-component="prompt-input-v2"]')) play("send", 800)
  }
  onMount(() => document.addEventListener("submit", sent, true))
  onCleanup(() => {
    document.removeEventListener("submit", sent, true)
    clearTimeout(timer)
  })

  return (
    <span class="lynx-mark" data-mood={mood()} data-beat={beat()} title={language.t(`lynx.mark.${mood()}` as never)}>
      <svg viewBox="0 0 64 64" width="22" height="22" aria-hidden="true">
        <defs>
          <radialGradient id={`${id}-g`} cx="0.5" cy="0.38" r="0.65">
            <stop offset="0" stop-color="#22D3EE" />
            <stop offset="1" stop-color="#6366F1" />
          </radialGradient>
          <clipPath id={`${id}-c`}>
            <circle cx="32" cy="32" r="21" />
          </clipPath>
        </defs>
        <circle class="lynx-mark-ring" cx="32" cy="32" r="28" />
        <circle class="lynx-mark-orb" cx="32" cy="32" r="21" fill={`url(#${id}-g)`} />
        <g clip-path={`url(#${id}-c)`} class="lynx-mark-code">
          <g class="lynx-mark-scroll">
            {[...CODE, ...CODE].map((line, index) => (
              <text x="14" y={14 + index * 7} font-size="5">
                {line}
              </text>
            ))}
          </g>
        </g>
        <path class="lynx-mark-gt" d="M22 24 L30 31 L22 38" />
        <path class="lynx-mark-gu" d="M33 40 H43" />
        <path class="lynx-mark-cursor" d="M25.5 18.5 L25.5 42 L31 37 L34.6 45 L38.8 43.2 L35.3 35.4 L42.6 35.4 Z" />
      </svg>
    </span>
  )
}
