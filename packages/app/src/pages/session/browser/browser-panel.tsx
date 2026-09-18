import { createSignal, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { authTokenFromCredentials } from "@/utils/server"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { browserPane } from "./pane-state"
import "./browser-panel.css"

/**
 * The instrument for the built-in browser.
 *
 * It docks above the composer like the measurement strip and only exists while
 * the browser is actually open, so the bench stays quiet when nothing is
 * running. Collapsed it reads out the page the agent is on; expanded it shows
 * the live screen, polled rather than streamed, because a PNG per action over
 * the event bus would cost far more than it is worth.
 */

type Tab = { id: string; url: string; title: string; active: boolean }
type Status = { running: boolean; browser?: string; headless: boolean; url?: string; title?: string; tabs: Tab[] }
type Frame = { running: boolean; url?: string; title?: string; image?: string }

/** How often the strip asks whether a browser is open at all. */
const STATUS_INTERVAL = 2500
/** How often the screen refreshes while it is being watched. */
const FRAME_INTERVAL = 1500

function host(url: string | undefined) {
  if (!url) return ""
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "file:") return parsed.pathname.split("/").pop() || url
    return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname)
  } catch {
    return url
  }
}

export function BrowserPanel(props: {
  directory: Accessor<string | undefined>
  /** The full browser pane is open, so this strip has nothing to add. */
  docked?: Accessor<boolean>
  /** The layout can show the full pane; otherwise the strip expands inline. */
  canDock?: Accessor<boolean>
}) {
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()

  const [status, setStatus] = createSignal<Status | undefined>()
  const [frame, setFrame] = createSignal<string | undefined>()
  const [open, setOpen] = createSignal(false)

  const request = async (path: string) => {
    const connection = server.current
    if (!connection) return undefined
    const url = new URL(`/experimental/browser/${path}`, connection.http.url)
    const dir = props.directory()
    if (dir) url.searchParams.set("directory", dir)
    const headers: Record<string, string> = {}
    if (connection.http.password) {
      headers.Authorization = `Basic ${authTokenFromCredentials({
        username: connection.http.username,
        password: connection.http.password,
      })}`
    }
    const response = await (platform.fetch ?? fetch)(url, { headers })
    if (!response.ok) return undefined
    return response.json()
  }

  onMount(() => {
    let stopped = false

    const pollStatus = async () => {
      // A hidden window should not keep screenshotting a page nobody is looking at.
      if (stopped || document.hidden) return
      const next = (await request("status").catch(() => undefined)) as Status | undefined
      if (stopped) return
      const wasRunning = status()?.running === true
      setStatus(next)
      // The agent starting to browse brings the pane up; a browser that shut
      // down lets it come up again next time.
      if (next?.running && !wasRunning && props.canDock?.()) browserPane.reveal()
      if (!next?.running) {
        if (wasRunning) browserPane.rearm()
        setFrame(undefined)
        setOpen(false)
      }
    }

    const pollFrame = async () => {
      if (stopped || document.hidden || !open() || !status()?.running) return
      const next = (await request("frame").catch(() => undefined)) as Frame | undefined
      if (stopped || !next?.image) return
      setFrame(next.image)
    }

    void pollStatus()
    const statusTimer = setInterval(pollStatus, STATUS_INTERVAL)
    const frameTimer = setInterval(pollFrame, FRAME_INTERVAL)

    onCleanup(() => {
      stopped = true
      clearInterval(statusTimer)
      clearInterval(frameTimer)
    })

    // Expanding should show a picture straight away, not after the next tick.
    const reveal = () => {
      if (open()) void pollFrame()
    }
    document.addEventListener("visibilitychange", reveal)
    onCleanup(() => document.removeEventListener("visibilitychange", reveal))
  })

  const label = () => host(status()?.url) || language.t("ui.tool.browser")
  const tabCount = () => status()?.tabs.length ?? 0

  return (
    <Show when={status()?.running && !props.docked?.()}>
      <div class="browser-panel" data-open={open() ? "" : undefined}>
        <Show when={open()}>
          <div class="browser-panel-screen">
            <Show
              when={frame()}
              fallback={<div class="browser-panel-waiting">{language.t("ui.browserPanel.loading")}</div>}
            >
              <img src={frame()} alt={status()?.title ?? ""} />
            </Show>
          </div>
        </Show>

        <button
          type="button"
          class="browser-panel-bar"
          onClick={() => {
            if (props.canDock?.()) browserPane.open()
            else setOpen((value) => !value)
          }}
          title={status()?.url ?? ""}
          aria-expanded={open()}
        >
          <span class="scope-strip-channel" data-chroma>
            <span class="scope-strip-led" />
            NAV
          </span>
          <span class="browser-panel-url">{label()}</span>
          <Show when={tabCount() > 1}>
            <span class="scope-strip-cell">
              <span class="scope-strip-unit">{language.t("ui.browserPanel.tabs")}</span>
              <span class="scope-readout">{tabCount()}</span>
            </span>
          </Show>
          <span class="browser-panel-hint">
            {open() ? language.t("ui.browserPanel.hide") : language.t("ui.browserPanel.show")}
          </span>
        </button>
      </div>
    </Show>
  )
}
