import { createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

const BARS = 36

/**
 * Talk to Lynx: a wave that follows your voice and the words appearing as you
 * speak, then dropped into the composer. Uses the browser's speech service;
 * where there is none (the desktop app has no key for it) it says so and
 * points to Windows dictation, which types into any field.
 */
export function LynxVoice() {
  const language = useLanguage()
  const platform = usePlatform()
  const [open, setOpen] = createSignal(false)
  const [text, setText] = createSignal("")
  const [levels, setLevels] = createSignal<number[]>(Array(BARS).fill(0.1))
  const [problem, setProblem] = createSignal<string>()
  const [seconds, setSeconds] = createSignal(0)
  let recognition: Recognition | undefined
  let stream: MediaStream | undefined
  let audio: AudioContext | undefined
  let frame: number | undefined
  let clock: ReturnType<typeof setInterval> | undefined
  let finalText = ""

  const stop = () => {
    recognition?.stop()
    recognition = undefined
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
    void audio?.close().catch(() => undefined)
    audio = undefined
    if (frame !== undefined) cancelAnimationFrame(frame)
    clearInterval(clock)
  }

  // In the desktop app the browser's speech service has no key, so Windows
  // dictation types straight into the composer instead.
  const system = async () => {
    const editor = document.querySelector<HTMLElement>('[data-component="prompt-input-v2"] [contenteditable="true"]')
    editor?.focus()
    if (await platform.dictate?.()) showToast({ title: language.t("lynx.voice.windows") })
  }

  const start = async () => {
    if (platform.dictate) return system()
    setOpen(true)
    setText("")
    setProblem(undefined)
    setSeconds(0)
    finalText = ""
    clock = setInterval(() => setSeconds((value) => value + 1), 1000)
    const Speech = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
    const Ctor = Speech.SpeechRecognition ?? Speech.webkitSpeechRecognition
    if (!Ctor) setProblem(language.t("lynx.voice.unsupported"))
    if (Ctor) {
      recognition = new Ctor()
      recognition.lang = language.intl()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.onresult = (event) => {
        let interim = ""
        finalText = ""
        for (let index = 0; index < event.results.length; index++) {
          const result = event.results[index]
          if (result.isFinal) finalText += result[0].transcript
          if (!result.isFinal) interim += result[0].transcript
        }
        setText((finalText + " " + interim).trim())
      }
      recognition.onerror = (event) =>
        setProblem(
          event.error === "not-allowed" ? language.t("lynx.voice.denied") : language.t("lynx.voice.unsupported"),
        )
      recognition.start()
    }
    // The wave follows the microphone even when no transcription service answers.
    const media = await navigator.mediaDevices?.getUserMedia({ audio: true }).catch(() => undefined)
    if (!media || !open()) return media?.getTracks().forEach((track) => track.stop())
    stream = media
    audio = new AudioContext()
    const analyser = audio.createAnalyser()
    analyser.fftSize = 128
    audio.createMediaStreamSource(media).connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    const draw = () => {
      analyser.getByteFrequencyData(data)
      setLevels(Array.from({ length: BARS }, (_, index) => Math.max(0.08, (data[index + 2] ?? 0) / 255)))
      frame = requestAnimationFrame(draw)
    }
    draw()
  }

  const finish = (send: boolean) => {
    stop()
    setOpen(false)
    const words = text().trim()
    if (!send || !words) return
    const editor = document.querySelector<HTMLElement>('[data-component="prompt-input-v2"] [contenteditable="true"]')
    if (!editor) return
    editor.focus()
    document.execCommand("insertText", false, words)
  }

  onCleanup(stop)

  return (
    <>
      <button
        type="button"
        class="lynx-bar-btn"
        aria-pressed={open()}
        title={language.t("lynx.voice.title")}
        onClick={() => (open() ? finish(true) : void start())}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="5.5" y="2" width="5" height="8" rx="2.5" fill="currentColor" />
          <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2" fill="none" stroke="currentColor" stroke-width="1.4" />
        </svg>
      </button>
      <Show when={open()}>
        <Portal>
          <div class="lynx-voice" role="dialog" aria-label={language.t("lynx.voice.title")} data-motion="l">
            <p class="lynx-voice-text">
              {text() || (problem() ?? language.t("lynx.voice.listening"))}
            </p>
            <div class="lynx-voice-row">
              <span class="lynx-voice-mic">●</span>
              <div class="lynx-voice-wave" aria-hidden="true">
                <For each={levels()}>{(level) => <i style={{ height: `${level * 100}%` }} />}</For>
              </div>
              <span class="lynx-voice-time">
                {Math.floor(seconds() / 60)}:{String(seconds() % 60).padStart(2, "0")}
              </span>
            </div>
            <div class="lynx-voice-actions">
              <button type="button" class="lynx-voice-cancel" onClick={() => finish(false)}>
                {language.t("common.cancel")}
              </button>
              <button type="button" class="lynx-voice-send" disabled={!text()} onClick={() => finish(true)}>
                {language.t("lynx.voice.insert")}
              </button>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}
