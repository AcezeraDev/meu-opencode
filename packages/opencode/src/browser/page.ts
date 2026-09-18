import { Effect } from "effect"
import { convertHTMLToMarkdown } from "@/tool/webfetch"
import { BrowserSnapshot, type SnapshotResult } from "./snapshot"
import type { Status } from "./session"
import type { ConsoleEntry, NetworkEntry, Tab } from "./tab"

/**
 * Turns a tool's targeting arguments into a CSS selector.
 *
 * Refs come from the last snapshot and are the reliable path, since the
 * snapshot tagged the element itself. A raw selector is the escape hatch for
 * elements the snapshot chose not to surface.
 */
export function selectorFor(input: { ref?: string; selector?: string }) {
  if (input.ref) return BrowserSnapshot.locator(input.ref)
  return input.selector
}

export const markdown = Effect.fn("BrowserPage.markdown")(function* (tab: Tab) {
  const result = yield* Effect.promise(() => tab.html())
  return { ...result, markdown: convertHTMLToMarkdown(result.html) }
})

/** Renders the page outline with a header the model can orient itself by. */
export function render(result: SnapshotResult) {
  const header = [`url: ${result.url}`, `title: ${result.title || "(untitled)"}`]
  if (result.truncated) header.push("note: outline truncated, raise maxNodes to see the rest")
  const body = result.outline.trim() || "(no visible content)"
  return [...header, "", body].join("\n")
}

export function renderStatus(status: Status) {
  if (!status.running) return "Browser is not running."
  const lines = [
    `browser: ${status.browser ?? "chromium"}${status.headless ? " (headless)" : ""}`,
    `url: ${status.url ?? "about:blank"}`,
    `title: ${status.title || "(untitled)"}`,
    "",
    "tabs:",
  ]
  for (const tab of status.tabs) {
    lines.push(`- ${tab.id}${tab.active ? " (active)" : ""}: ${tab.title || "(untitled)"} - ${tab.url}`)
  }
  return lines.join("\n")
}

export function renderConsole(entries: ConsoleEntry[]) {
  if (!entries.length) return "No console output captured."
  return entries.map((entry) => `[${entry.type}] ${entry.text}`).join("\n")
}

export function renderNetwork(entries: NetworkEntry[]) {
  if (!entries.length) return "No requests captured."
  return entries
    .map((entry) => {
      const outcome = entry.failure ? `FAILED ${entry.failure}` : (entry.status?.toString() ?? "pending")
      return `${entry.method} ${outcome} ${entry.url}`
    })
    .join("\n")
}

export * as BrowserPage from "./page"
