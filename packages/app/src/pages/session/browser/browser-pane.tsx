import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { useLanguage } from "@/context/language"
import { createBrowserFeed, type BrowserActivity, type BrowserFrame } from "./browser-feed"
import "./browser-pane.css"

/**
 * The agent's browser, live and shared.
 *
 * It is a remote view, not a picture: the page is streamed from the browser the
 * agent drives, and the mouse and keyboard used here go back to that same
 * browser. So a person can open the site, sign in, and hand over, or watch the
 * agent and step in, the way the browser panes in Claude and Codex work.
 */

/** How long an agent action stays in the caption after it happened. */
const CAPTION_MS = 4000
/** Pointer moves are sampled, not all sent: the page only needs where it ended up. */
const MOVE_INTERVAL_MS = 30
/** Dragging the pane's edge resizes it continuously; the page relays out once it settles. */
const FIT_DELAY_MS = 250

const ACTIVITY_KEYS: Record<string, string> = {
  navigate: "ui.browserPane.agent.navigate",
  reload: "ui.browserPane.agent.reload",
  back: "ui.browserPane.agent.back",
  forward: "ui.browserPane.agent.forward",
  click: "ui.browserPane.agent.click",
  double_click: "ui.browserPane.agent.double_click",
  right_click: "ui.browserPane.agent.right_click",
  hover: "ui.browserPane.agent.hover",
  fill: "ui.browserPane.agent.fill",
  type: "ui.browserPane.agent.type",
  press: "ui.browserPane.agent.press",
  select: "ui.browserPane.agent.select",
  check: "ui.browserPane.agent.check",
  uncheck: "ui.browserPane.agent.uncheck",
  scroll: "ui.browserPane.agent.scroll",
  wait: "ui.browserPane.agent.wait",
  read: "ui.browserPane.agent.read",
  screenshot: "ui.browserPane.agent.screenshot",
  inspect: "ui.browserPane.agent.inspect",
  handoff: "ui.browserPane.agent.handoff",
}

/** Activities whose target is a page, shown by its site rather than quoted. */
const PAGE_ACTIVITIES = new Set(["navigate", "back", "forward", "handoff"])

const BUTTONS = ["left", "middle", "right"] as const

function host(url: string | undefined) {
  if (!url) return ""
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "file:") return parsed.pathname.split("/").pop() || url
    if (parsed.protocol === "about:") return ""
    return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname)
  } catch {
    return url
  }
}

/** CDP's modifier bitmask. */
function modifiers(event: KeyboardEvent | MouseEvent) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

function Glyph(props: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={props.d}
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

const GLYPH = {
  back: "M10 3 L5 8 L10 13",
  forward: "M6 3 L11 8 L6 13",
  reload: "M13 8 A5 5 0 1 1 11.5 4.4 M13 2.5 V5.2 H10.3",
  plus: "M8 3.5 V12.5 M3.5 8 H12.5",
  close: "M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5",
  external: "M9.5 2.5 H13.5 V6.5 M13.5 2.5 L8 8 M11.5 9.5 V13.5 H2.5 V4.5 H6.5",
}

export function BrowserPane(props: { directory: Accessor<string | undefined>; onClose: () => void }) {
  const language = useLanguage()
  const feed = createBrowserFeed({ directory: props.directory, enabled: () => true })

  let canvas: HTMLCanvasElement | undefined
  let screen: HTMLDivElement | undefined
  let addressInput: HTMLInputElement | undefined
  /** The page's viewport in CSS pixels, which input coordinates are expressed in. */
  let viewport = { width: 0, height: 0 }

  const [hasFrame, setHasFrame] = createSignal(false)
  const [address, setAddress] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  const status = () => feed.status()
  const running = () => status()?.running === true
  const live = () => feed.connected() && running()
  /** Only a web page can go to another browser; a blank tab or a local file cannot. */
  const handable = () => running() && /^https?:\/\//.test(status()?.url ?? "")
  const externalName = () => status()?.external || language.t("ui.browserPane.defaultBrowser")

  // The address bar follows the page, except while someone is typing in it.
  createEffect(() => {
    const url = status()?.url
    if (!editing()) setAddress(url && url !== "about:blank" ? url : "")
  })

  // A closed browser leaves no stale picture behind.
  createEffect(() => {
    if (running()) return
    setHasFrame(false)
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height)
  })

  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    onCleanup(() => clearInterval(timer))
  })

  // The page is laid out at the pane's size, so it fills the screen instead of
  // sitting letterboxed in it, the way a browser window fills its frame.
  const [size, setSize] = createSignal<{ width: number; height: number }>()
  onMount(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      clearTimeout(timer)
      timer = setTimeout(() => setSize({ width: Math.round(width), height: Math.round(height) }), FIT_DELAY_MS)
    })
    observer.observe(screen!)
    onCleanup(() => {
      clearTimeout(timer)
      observer.disconnect()
    })
  })
  createEffect(() => {
    const next = size()
    // Re-sent whenever the browser (re)starts, since a fresh one has no size yet.
    if (!next || !running()) return
    void feed.control({ action: "resize", width: next.width, height: next.height })
  })

  // Frames are decoded off the main path and drawn straight to the canvas. If
  // one arrives while the last is still decoding, only the newest is kept.
  onMount(() => {
    let decoding = false
    let pending: BrowserFrame | undefined
    const draw = async (frame: BrowserFrame) => {
      if (decoding) {
        pending = frame
        return
      }
      decoding = true
      try {
        const bytes = Uint8Array.from(atob(frame.data), (char) => char.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }))
        if (canvas) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
          }
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
          viewport = { width: frame.width || bitmap.width, height: frame.height || bitmap.height }
          setHasFrame(true)
        }
        bitmap.close()
      } catch {
        // A frame that fails to decode is simply skipped.
      } finally {
        decoding = false
        const next = pending
        pending = undefined
        if (next) void draw(next)
      }
    }
    const stop = feed.onFrame((frame) => void draw(frame))
    onCleanup(() => void stop())
  })

  /** Maps a pointer position on the canvas to the page's viewport. */
  const point = (event: MouseEvent) => {
    const rect = canvas!.getBoundingClientRect()
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * viewport.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * viewport.height),
    }
  }

  let lastMove = 0
  const onPointerMove = (event: PointerEvent) => {
    if (!hasFrame()) return
    const time = performance.now()
    // A drag must not lose its path, so only hover moves are sampled.
    if (event.buttons === 0 && time - lastMove < MOVE_INTERVAL_MS) return
    lastMove = time
    feed.input({ type: "mouse", action: "move", ...point(event), buttons: event.buttons, modifiers: modifiers(event) })
  }

  const onPointerDown = (event: PointerEvent) => {
    if (!hasFrame()) return
    event.preventDefault()
    canvas!.focus()
    canvas!.setPointerCapture(event.pointerId)
    feed.input({
      type: "mouse",
      action: "down",
      ...point(event),
      button: BUTTONS[event.button] ?? "left",
      buttons: event.buttons,
      clickCount: event.detail || 1,
      modifiers: modifiers(event),
    })
  }

  const onPointerUp = (event: PointerEvent) => {
    if (!hasFrame()) return
    feed.input({
      type: "mouse",
      action: "up",
      ...point(event),
      button: BUTTONS[event.button] ?? "left",
      buttons: event.buttons,
      clickCount: event.detail || 1,
      modifiers: modifiers(event),
    })
  }

  const onKey = (action: "down" | "up") => (event: KeyboardEvent) => {
    // Pasting goes through the paste event instead, so the page receives this
    // machine's clipboard rather than the headless browser's empty one.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return
    // Keys typed into the page must not also trigger the app's own shortcuts.
    event.preventDefault()
    event.stopPropagation()
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey
    const text = event.key === "Enter" ? "\r" : printable ? event.key : undefined
    feed.input({
      type: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      text: action === "down" ? text : undefined,
      modifiers: modifiers(event),
    })
  }

  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain")
    if (!text) return
    event.preventDefault()
    feed.input({ type: "text", text })
  }

  onMount(() => {
    // Registered by hand because Solid's delegated wheel listener is passive,
    // and scrolling the page must not also scroll the app.
    const onWheel = (event: WheelEvent) => {
      if (!hasFrame()) return
      event.preventDefault()
      const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1
      feed.input({
        type: "wheel",
        ...point(event),
        deltaX: event.deltaX * scale,
        deltaY: event.deltaY * scale,
        modifiers: modifiers(event),
      })
    }
    canvas!.addEventListener("wheel", onWheel, { passive: false })
    onCleanup(() => canvas?.removeEventListener("wheel", onWheel))
  })

  const go = () => {
    const value = address().trim()
    if (!value) return
    setEditing(false)
    addressInput?.blur()
    void feed.control({ action: "navigate", url: value })
    canvas?.focus()
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    go()
  }

  const caption = createMemo(() => {
    const activity: BrowserActivity | undefined = feed.activity()
    if (!activity || now() - activity.at > CAPTION_MS) return undefined
    const key = ACTIVITY_KEYS[activity.kind]
    if (!key) return undefined
    const target = activity.target
    const shown = PAGE_ACTIVITIES.has(activity.kind)
      ? host(target) || target || ""
      : activity.kind === "press" || activity.kind === "inspect"
        ? (target ?? "")
        : target
          ? `“${target}”`
          : language.t("ui.browserPane.agent.element")
    return language.t(key, { target: shown, browser: externalName() })
  })

  return (
    // data-prevent-autofocus: typing into the page must not be taken for typing
    // to the agent, which is what a stray keystroke means elsewhere in a session.
    <section class="browser-pane" aria-label={language.t("ui.browserPane.title")} data-prevent-autofocus>
      <div class="browser-pane-tabs" role="tablist">
        <For each={status()?.tabs ?? []}>
          {(tab) => (
            <div class="browser-pane-tab" data-active={tab.active ? "" : undefined}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.active}
                class="browser-pane-tab-label"
                title={tab.url}
                onClick={() => void feed.control({ action: "select_tab", tab: tab.id })}
              >
                {tab.title || host(tab.url) || language.t("ui.browserPane.newTab")}
              </button>
              <button
                type="button"
                class="browser-pane-icon browser-pane-tab-close"
                aria-label={language.t("ui.browserPane.closeTab")}
                onClick={() => void feed.control({ action: "close_tab", tab: tab.id })}
              >
                <Glyph d={GLYPH.close} />
              </button>
            </div>
          )}
        </For>
        <button
          type="button"
          class="browser-pane-icon"
          aria-label={language.t("ui.browserPane.newTab")}
          title={language.t("ui.browserPane.newTab")}
          onClick={() => void feed.control({ action: "new_tab" })}
        >
          <Glyph d={GLYPH.plus} />
        </button>
        <span class="browser-pane-spacer" />
        <Show when={live()}>
          <span class="browser-pane-live" data-chroma>
            <span class="browser-pane-led" />
            {language.t("ui.browserPane.live")}
          </span>
        </Show>
        <button
          type="button"
          class="browser-pane-icon"
          aria-label={language.t("ui.browserPane.close")}
          title={language.t("ui.browserPane.close")}
          onClick={() => props.onClose()}
        >
          <Glyph d={GLYPH.close} />
        </button>
      </div>

      <form class="browser-pane-toolbar" onSubmit={submit}>
        <button
          type="button"
          class="browser-pane-icon"
          aria-label={language.t("ui.browserPane.back")}
          title={language.t("ui.browserPane.back")}
          disabled={!running()}
          onClick={() => void feed.control({ action: "back" })}
        >
          <Glyph d={GLYPH.back} />
        </button>
        <button
          type="button"
          class="browser-pane-icon"
          aria-label={language.t("ui.browserPane.forward")}
          title={language.t("ui.browserPane.forward")}
          disabled={!running()}
          onClick={() => void feed.control({ action: "forward" })}
        >
          <Glyph d={GLYPH.forward} />
        </button>
        <button
          type="button"
          class="browser-pane-icon"
          aria-label={language.t("ui.browserPane.reload")}
          title={language.t("ui.browserPane.reload")}
          disabled={!running()}
          onClick={() => void feed.control({ action: "reload" })}
        >
          <Glyph d={GLYPH.reload} />
        </button>
        <button
          type="button"
          class="browser-pane-icon"
          aria-label={language.t("ui.browserPane.openExternal", { browser: externalName() })}
          title={language.t("ui.browserPane.openExternal", { browser: externalName() })}
          disabled={!handable()}
          onClick={() => void feed.control({ action: "open_external" })}
        >
          <Glyph d={GLYPH.external} />
        </button>
        <input
          ref={addressInput}
          class="browser-pane-address"
          type="text"
          spellcheck={false}
          autocomplete="off"
          placeholder={language.t("ui.browserPane.address")}
          aria-label={language.t("ui.browserPane.address")}
          value={address()}
          onFocus={(event) => {
            setEditing(true)
            event.currentTarget.select()
          }}
          onBlur={() => setEditing(false)}
          onInput={(event) => setAddress(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Handled here rather than left to the form, because the app's own
            // key handling can swallow Enter before the form ever submits.
            if (event.key === "Enter") {
              event.preventDefault()
              event.stopPropagation()
              go()
              return
            }
            if (event.key !== "Escape") return
            setEditing(false)
            event.currentTarget.blur()
          }}
        />
      </form>

      <div class="browser-pane-screen" ref={screen}>
        <canvas
          ref={canvas}
          class="browser-pane-canvas"
          data-ready={hasFrame() ? "" : undefined}
          tabIndex={0}
          aria-label={status()?.title || language.t("ui.browserPane.title")}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={onKey("down")}
          onKeyUp={onKey("up")}
          onPaste={onPaste}
        />
        <Show when={!running()}>
          <Show
            when={status()?.mode === "extension"}
            fallback={
              <div class="browser-pane-empty">
                <p class="browser-pane-empty-title">{language.t("ui.browserPane.closed")}</p>
                <p class="browser-pane-empty-hint">{language.t("ui.browserPane.closedHint")}</p>
              </div>
            }
          >
            <div class="browser-pane-empty">
              <p class="browser-pane-empty-title">{language.t("ui.browserPane.pairTitle")}</p>
              <p class="browser-pane-empty-hint">
                {language.t("ui.browserPane.pairHint", { port: feed.serverPort() ?? "?" })}
              </p>
            </div>
          </Show>
        </Show>
        <Show when={running() && !hasFrame()}>
          <div class="browser-pane-empty">
            <p class="browser-pane-empty-hint">{language.t("ui.browserPane.connecting")}</p>
          </div>
        </Show>
      </div>

      <div class="browser-pane-caption" data-active={caption() ? "" : undefined} aria-live="polite">
        <Show when={caption()}>
          <span class="browser-pane-agent" data-chroma>
            <span class="browser-pane-led" />
            {language.t("ui.browserPane.agent.label")}
          </span>
          <span class="browser-pane-caption-text">{caption()}</span>
        </Show>
      </div>
    </section>
  )
}
