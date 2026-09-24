import type { AssistantMessage, ToolPart } from "@opencode-ai/sdk/v2"
import { useData } from "@opencode-ai/session-ui/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { createMemo, createResource, createSignal, For, Show, type Accessor } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import "./browser-history.css"

/**
 * What the agent did in the browser this session, under the live view: how
 * long went to the browser and how long to the model thinking, and, opened,
 * the page as it was after each step, to look back over a lesson.
 */
export function BrowserHistory(props: { sessionID: Accessor<string | undefined> }) {
  const sync = useSync()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)

  const assistants = createMemo(() =>
    (sync().data.message[props.sessionID() ?? ""] ?? []).filter(
      (message): message is AssistantMessage => message.role === "assistant",
    ),
  )
  const tools = createMemo(() =>
    assistants().flatMap((message) =>
      (sync().data.part[message.id] ?? []).filter((part): part is ToolPart => part.type === "tool"),
    ),
  )
  const steps = createMemo(() => tools().filter((part) => part.tool.startsWith("browser_")))

  const times = createMemo(() => {
    const spent = (part: ToolPart) =>
      part.state.status === "completed" || part.state.status === "error" ? part.state.time.end - part.state.time.start : 0
    const browser = steps().reduce((total, part) => total + spent(part), 0)
    const allTools = tools().reduce((total, part) => total + spent(part), 0)
    // A reply's own time, less the tools it ran, is the model thinking and writing.
    const replies = assistants().reduce(
      (total, message) => total + (message.time.completed ? message.time.completed - message.time.created : 0),
      0,
    )
    return { browser, model: Math.max(0, replies - allTools) }
  })

  const shots = createMemo(() =>
    steps().filter((part) => part.state.status === "completed" && typeof part.state.metadata?.shot === "string"),
  )

  return (
    <Show when={steps().length > 0}>
      <div class="browser-history" data-open={open() ? "" : undefined}>
        <button type="button" class="browser-history-bar" onClick={() => setOpen((value) => !value)} aria-expanded={open()}>
          <span class="browser-history-summary">
            {language.t("browser.history.summary", {
              steps: steps().length,
              browser: duration(times().browser),
              model: duration(times().model),
            })}
          </span>
          <Show when={shots().length > 0}>
            <span class="browser-history-toggle">
              {open() ? language.t("browser.history.hide") : language.t("browser.history.show")}
            </span>
          </Show>
        </button>
        <Show when={open()}>
          <ol class="browser-history-steps">
            <For each={shots()}>
              {(part, index) => <HistoryStep part={part} number={index() + 1} sessionID={props.sessionID() ?? ""} />}
            </For>
          </ol>
        </Show>
      </div>
    </Show>
  )
}

function HistoryStep(props: { part: ToolPart; number: number; sessionID: string }) {
  const data = useData()
  const dialog = useDialog()
  const title = () => {
    if (props.part.state.status !== "completed") return props.part.tool
    const metadata = props.part.state.metadata ?? {}
    // What was clicked or typed into, by its name; otherwise the page it went to.
    if (typeof metadata.target === "string" && metadata.target) return `“${metadata.target}”`
    if (typeof metadata.url === "string" && metadata.url) return place(metadata.url)
    return props.part.state.title || props.part.tool
  }
  const shot = () =>
    props.part.state.status === "completed" && typeof props.part.state.metadata?.shot === "string"
      ? props.part.state.metadata.shot
      : undefined
  // `.latest` with an initial value never suspends the page (see BrowserToolCard).
  const [image] = createResource(shot, (callID) => data.browserShot?.(props.sessionID, callID).catch(() => undefined), {
    initialValue: undefined,
  })
  return (
    <li class="browser-history-step">
      <button
        type="button"
        disabled={!image.latest}
        onClick={() => {
          const src = image.latest
          if (src) dialog.show(() => <ImagePreview src={src} alt={title()} />)
        }}
      >
        <Show when={image.latest} fallback={<span class="browser-history-placeholder" />}>
          {(src) => <img src={src()} alt="" loading="lazy" />}
        </Show>
        <span class="browser-history-label">
          <span class="browser-history-number">{props.number}</span>
          {title()}
        </span>
      </button>
    </li>
  )
}

/** A page by its path, which says more than the site it is on. */
function place(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.pathname === "/" ? parsed.host : parsed.pathname + parsed.search
  } catch {
    return url
  }
}

/** "45 s", "3 min 20 s", "1 h 05 min". */
function duration(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`
}
