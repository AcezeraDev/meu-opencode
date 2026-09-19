import { useI18n } from "@opencode-ai/ui/context/i18n"
import { createMemo, Show } from "solid-js"
import { BasicTool } from "./basic-tool"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import type { ToolProps } from "./message-part"

/**
 * One card shape for every browser tool.
 *
 * What the user wants to see at a glance is the same in all of them: what the
 * browser is doing and which page it is doing it on. The heading names the
 * action, the subheading is the page, and the details stay collapsed because
 * the raw output is a page outline that only the model needs.
 */

const ACT_LABELS: Record<string, string> = {
  click: "ui.tool.browser.action.click",
  double_click: "ui.tool.browser.action.double_click",
  right_click: "ui.tool.browser.action.right_click",
  hover: "ui.tool.browser.action.hover",
  fill: "ui.tool.browser.action.fill",
  type: "ui.tool.browser.action.type",
  press: "ui.tool.browser.action.press",
  select: "ui.tool.browser.action.select",
  check: "ui.tool.browser.action.check",
  uncheck: "ui.tool.browser.action.uncheck",
  scroll: "ui.tool.browser.action.scroll",
  wait_for: "ui.tool.browser.action.wait_for",
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

  const heading = createMemo(() => {
    // A page the site refused to the agent went to the user's own browser.
    const handoff = props.metadata?.handoff
    if (typeof handoff === "string") {
      return i18n.t("ui.tool.browser.handoff", { browser: handoff || i18n.t("ui.browserPane.defaultBrowser") })
    }
    if (props.tool === "browser_screenshot") return i18n.t("ui.tool.browser.screenshot")
    if (props.tool === "browser_snapshot") return i18n.t("ui.tool.browser.read")
    if (props.tool === "browser_inspect") {
      const what = typeof props.input?.what === "string" ? props.input.what : "console"
      return i18n.t(INSPECT_LABELS[what] ?? "ui.tool.browser")
    }
    if (props.tool === "browser_act") {
      const action = typeof props.input?.action === "string" ? props.input.action : ""
      const key = ACT_LABELS[action]
      return key ? i18n.t(key) : i18n.t("ui.tool.browser")
    }
    const action = typeof props.input?.action === "string" ? props.input.action : ""
    if (action === "list_tabs") return i18n.t("ui.tool.browser.tabs")
    if (action === "close_browser") return i18n.t("ui.tool.browser.closed")
    return i18n.t("ui.tool.browser.navigate")
  })

  /** For an interaction, the element is more informative than the page. */
  const detail = createMemo(() => {
    if (props.tool !== "browser_act") return ""
    const text = props.input?.text
    if (typeof text === "string" && text) return text
    const ref = props.input?.ref ?? props.input?.selector
    return typeof ref === "string" ? ref : ""
  })

  const subtitle = createMemo(() => detail() || (url() ? host(url()) : ""))

  return (
    <BasicTool
      {...props}
      icon="window-cursor"
      trigger={
        <div data-slot="basic-tool-tool-info-structured">
          <div data-slot="basic-tool-tool-info-main">
            <span data-slot="basic-tool-tool-title">
              <TextShimmer text={heading()} active={pending()} />
            </span>
            <Show when={subtitle()}>
              <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
            </Show>
          </div>
        </div>
      }
    />
  )
}
