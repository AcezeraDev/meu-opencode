import { useI18n } from "@opencode-ai/ui/context/i18n"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useData } from "../context/data"
import { BasicTool } from "./basic-tool"
import "./browser-tool.css"
import type { ToolProps } from "./message-part"
import { ToolStatusTitle } from "./tool-status-title"

/**
 * One card shape for every browser tool.
 *
 * What the user wants to see at a glance is the same in all of them: what the
 * browser is doing and which page it is doing it on. The heading names the
 * action, the subheading is the page, and the details stay collapsed because
 * the raw output is a page outline that only the model needs.
 */

const ACT_LABELS: Record<string, { active: string; done: string }> = {
  click: { active: "ui.tool.browser.action.click.active", done: "ui.tool.browser.action.click.done" },
  double_click: {
    active: "ui.tool.browser.action.double_click.active",
    done: "ui.tool.browser.action.double_click.done",
  },
  right_click: {
    active: "ui.tool.browser.action.right_click.active",
    done: "ui.tool.browser.action.right_click.done",
  },
  hover: { active: "ui.tool.browser.action.hover.active", done: "ui.tool.browser.action.hover.done" },
  fill: { active: "ui.tool.browser.action.fill.active", done: "ui.tool.browser.action.fill.done" },
  type: { active: "ui.tool.browser.action.type.active", done: "ui.tool.browser.action.type.done" },
  press: { active: "ui.tool.browser.action.press.active", done: "ui.tool.browser.action.press.done" },
  select: { active: "ui.tool.browser.action.select.active", done: "ui.tool.browser.action.select.done" },
  check: { active: "ui.tool.browser.action.check.active", done: "ui.tool.browser.action.check.done" },
  uncheck: { active: "ui.tool.browser.action.uncheck.active", done: "ui.tool.browser.action.uncheck.done" },
  scroll: { active: "ui.tool.browser.action.scroll.active", done: "ui.tool.browser.action.scroll.done" },
  wait_for: { active: "ui.tool.browser.action.wait_for.active", done: "ui.tool.browser.action.wait_for.done" },
}

const INSPECT_LABELS: Record<string, string> = {
  console: "ui.tool.browser.console",
  network: "ui.tool.browser.network",
  evaluate: "ui.tool.browser.evaluate",
}

/** Shows the site rather than the full URL, which is usually noise. */
function host(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "file:") return parsed.pathname.split("/").pop() || url
    return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname)
  } catch {
    return url
  }
}

export function BrowserToolCard(props: ToolProps) {
  const i18n = useI18n()
  const pending = createMemo(() => props.status === "pending" || props.status === "running")

  const url = createMemo(() => {
    const fromMetadata = props.metadata?.url
    if (typeof fromMetadata === "string" && fromMetadata !== "about:blank") return fromMetadata
    const fromInput = props.input?.url
    return typeof fromInput === "string" ? fromInput : ""
  })

  const headings = createMemo(() => {
    // A page the site refused to the agent went to the user's own browser.
    const handoff = props.metadata?.handoff
    if (typeof handoff === "string") {
      const browser = handoff || i18n.t("ui.browserPane.defaultBrowser")
      return {
        active: i18n.t("ui.tool.browser.handoff.active", { browser }),
        done: i18n.t("ui.tool.browser.handoff", { browser }),
      }
    }
    if (props.tool === "browser_screenshot")
      return {
        active: i18n.t("ui.tool.browser.screenshot.active"),
        done: i18n.t("ui.tool.browser.screenshot.done"),
      }
    if (props.tool === "browser_script")
      return { active: i18n.t("ui.tool.browser.script.active"), done: i18n.t("ui.tool.browser.script.done") }
    if (props.tool === "browser_notes")
      return { active: i18n.t("ui.tool.browser.notes.active"), done: i18n.t("ui.tool.browser.notes.done") }
    if (props.tool === "browser_snapshot")
      return { active: i18n.t("ui.tool.browser.read"), done: i18n.t("ui.tool.browser.read.done") }
    if (props.tool === "browser_inspect") {
      const what = typeof props.input?.what === "string" ? props.input.what : "console"
      const key = INSPECT_LABELS[what]
      if (!key) return { active: i18n.t("ui.tool.browser.active"), done: i18n.t("ui.tool.browser.done") }
      return { active: i18n.t(`${key}.active`), done: i18n.t(`${key}.done`) }
    }
    if (props.tool === "browser_act") {
      const action = typeof props.input?.action === "string" ? props.input.action : ""
      const keys = ACT_LABELS[action]
      if (!keys) return { active: i18n.t("ui.tool.browser.active"), done: i18n.t("ui.tool.browser.done") }
      return { active: i18n.t(keys.active), done: i18n.t(keys.done) }
    }
    const action = typeof props.input?.action === "string" ? props.input.action : ""
    if (action === "list_tabs")
      return { active: i18n.t("ui.tool.browser.tabs.active"), done: i18n.t("ui.tool.browser.tabs.done") }
    if (action === "close_browser")
      return { active: i18n.t("ui.tool.browser.closed.active"), done: i18n.t("ui.tool.browser.closed") }
    return { active: i18n.t("ui.tool.browser.navigate"), done: i18n.t("ui.tool.browser.navigate.done") }
  })

  /** For an interaction, the element is more informative than the page. */
  const detail = createMemo(() => {
    // A saved program is known by its name.
    if (props.tool === "browser_script") return typeof props.input?.name === "string" ? props.input.name : ""
    // The note itself, or the site whose notes were read.
    if (props.tool === "browser_notes") {
      if (typeof props.input?.add === "string" && props.input.add) return props.input.add
      return typeof props.metadata?.host === "string" ? props.metadata.host : ""
    }
    if (props.tool !== "browser_act") return ""
    const target = props.metadata?.target
    if (typeof target === "string" && target) return `“${target}”`
    const text = props.input?.text
    if (typeof text === "string" && text) return text
    const ref = props.input?.ref ?? props.input?.selector
    return typeof ref === "string" ? ref : ""
  })

  const subtitle = createMemo(() => detail() || (url() ? host(url()) : ""))

  // The picture of the page after this step, fetched once the card is on
  // screen: a long lesson has hundreds of steps, and most are never looked at.
  const data = useData()
  const dialog = useDialog()
  const [seen, setSeen] = createSignal(false)
  let holder: HTMLSpanElement | undefined
  onMount(() => {
    if (!holder || typeof IntersectionObserver === "undefined") return setSeen(true)
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setSeen(true)
      observer.disconnect()
    })
    observer.observe(holder)
    onCleanup(() => observer.disconnect())
  })
  const shot = createMemo(() => {
    const id = props.metadata?.shot
    return seen() && typeof id === "string" && props.sessionID ? { sessionID: props.sessionID, callID: id } : undefined
  })
  // Read through `.latest` with an initial value: reading the resource itself
  // while it loads suspends the page's <Suspense>, which blanks the whole
  // screen on every browser step.
  const [image] = createResource(
    shot,
    async (target) => {
      // The picture is taken just after the step answers, so a card that shows
      // up right then may ask a moment too early.
      for (let attempt = 0; attempt < 4; attempt++) {
        const found = await data.browserShot?.(target.sessionID, target.callID).catch(() => undefined)
        if (found || !data.browserShot) return found
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
      return undefined
    },
    { initialValue: undefined },
  )

  return (
    <BasicTool
      {...props}
      icon="window-cursor"
      trigger={
        <div data-slot="basic-tool-tool-info-structured">
          <div data-slot="basic-tool-tool-info-main">
            <span data-slot="basic-tool-tool-title">
              <ToolStatusTitle active={pending()} activeText={headings().active} doneText={headings().done} />
            </span>
            <Show when={subtitle()}>
              <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
            </Show>
          </div>
          <span ref={holder} data-slot="browser-tool-shot">
            <Show when={image.latest}>
              {(src) => (
                <img
                  src={src()}
                  alt={i18n.t("ui.tool.browser.shot")}
                  title={i18n.t("ui.tool.browser.shot")}
                  onClick={(event) => {
                    event.stopPropagation()
                    dialog.show(() => <ImagePreview src={src()} alt={subtitle()} />)
                  }}
                />
              )}
            </Show>
          </span>
        </div>
      }
    />
  )
}
