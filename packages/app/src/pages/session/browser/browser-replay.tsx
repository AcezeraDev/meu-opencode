import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { createResource, createSignal, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import "./browser-replay.css"

export type ReplayStep = { callID: string; title: string }

const WIDTH = 1280
const HEIGHT = 720
const SPEEDS = [1500, 800, 3000]

/**
 * Plays the pictures of the agent's browser steps one after another, with
 * what each step did written under it, to see a whole lesson in seconds. It
 * can be saved as a video, recorded straight from the canvas it plays on.
 */
export function BrowserReplay(props: {
  steps: ReplayStep[]
  load: (callID: string) => Promise<string | undefined>
  close: () => void
}) {
  const language = useLanguage()
  const [frame, setFrame] = createSignal(0)
  const [playing, setPlaying] = createSignal(true)
  const [speed, setSpeed] = createSignal(0)
  const [recording, setRecording] = createSignal(false)
  let canvas: HTMLCanvasElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const [images] = createResource(async () => {
    const loaded = await Promise.all(
      props.steps.map(async (step) => {
        const src = await props.load(step.callID).catch(() => undefined)
        if (!src) return undefined
        const image = new Image()
        image.src = src
        await image.decode().catch(() => undefined)
        return { image, title: step.title }
      }),
    )
    return loaded.filter((item) => item !== undefined)
  })

  const draw = (index: number) => {
    const list = images()
    const context = canvas?.getContext("2d")
    if (!list?.length || !context) return
    const item = list[index]!
    context.fillStyle = "#111"
    context.fillRect(0, 0, WIDTH, HEIGHT)
    const room = HEIGHT - 56
    const scale = Math.min(WIDTH / item.image.naturalWidth, room / item.image.naturalHeight)
    const width = item.image.naturalWidth * scale
    const height = item.image.naturalHeight * scale
    context.drawImage(item.image, (WIDTH - width) / 2, (room - height) / 2, width, height)
    context.fillStyle = "#ededed"
    context.font = "500 22px system-ui, 'Segoe UI', sans-serif"
    context.textBaseline = "middle"
    const caption = `${index + 1}/${list.length} · ${item.title}`
    context.fillText(caption.length > 110 ? caption.slice(0, 109) + "…" : caption, 24, HEIGHT - 28)
  }

  const schedule = () => {
    clearTimeout(timer)
    if (!playing()) return
    timer = setTimeout(() => {
      const count = images()?.length ?? 0
      if (!count) return
      show((frame() + 1) % count)
      schedule()
    }, SPEEDS[speed()])
  }

  const show = (index: number) => {
    setFrame(index)
    draw(index)
  }

  const toggle = () => {
    setPlaying((value) => !value)
    schedule()
  }

  const step = (delta: number) => {
    const count = images()?.length ?? 0
    if (!count) return
    setPlaying(false)
    clearTimeout(timer)
    show((frame() + delta + count) % count)
  }

  const record = async () => {
    const list = images()
    if (!canvas || !list?.length || recording()) return
    setRecording(true)
    setPlaying(false)
    clearTimeout(timer)
    const stream = canvas.captureStream(30)
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => chunks.push(event.data)
    const done = new Promise((resolve) => (recorder.onstop = resolve))
    recorder.start()
    for (const index of list.keys()) {
      show(index)
      // A canvas stream only carries a frame when the canvas is drawn, so the
      // picture is drawn again while it holds, or the video would skip it.
      const until = Date.now() + SPEEDS[speed()]
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        draw(index)
      }
    }
    recorder.stop()
    await done
    const link = document.createElement("a")
    link.href = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }))
    link.download = `passos-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.webm`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000)
    setRecording(false)
  }

  onCleanup(() => clearTimeout(timer))

  return (
    <DialogV2 size="x-large">
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("browser.replay.title")}
          description={language.t("browser.replay.description", { count: props.steps.length })}
        />
      </DialogHeader>
      <DialogBody class="browser-replay">
        <Show
          when={images()?.length}
          fallback={
            <p class="browser-replay-empty">
              {images.loading ? language.t("browser.replay.loading") : language.t("browser.replay.empty")}
            </p>
          }
        >
          <canvas
            class="browser-replay-canvas"
            width={WIDTH}
            height={HEIGHT}
            ref={(element) => {
              canvas = element
              queueMicrotask(() => {
                show(0)
                schedule()
              })
            }}
          />
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" disabled={recording()} onClick={() => step(-1)}>
          {language.t("browser.replay.previous")}
        </ButtonV2>
        <ButtonV2 variant="ghost" disabled={recording()} onClick={toggle}>
          {playing() ? language.t("browser.replay.pause") : language.t("browser.replay.play")}
        </ButtonV2>
        <ButtonV2 variant="ghost" disabled={recording()} onClick={() => step(1)}>
          {language.t("browser.replay.next")}
        </ButtonV2>
        <ButtonV2
          variant="ghost"
          disabled={recording()}
          onClick={() => {
            setSpeed((value) => (value + 1) % SPEEDS.length)
            schedule()
          }}
        >
          {language.t(`browser.replay.speed.${speed()}` as "browser.replay.speed.0")}
        </ButtonV2>
        <ButtonV2 disabled={recording() || !images()?.length} onClick={() => void record()}>
          {recording() ? language.t("browser.replay.recording") : language.t("browser.replay.download")}
        </ButtonV2>
        <ButtonV2 variant="ghost" onClick={props.close}>
          {language.t("common.close")}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}
