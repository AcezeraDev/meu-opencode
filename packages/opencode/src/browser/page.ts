import { Effect } from "effect"
import { convertHTMLToMarkdown } from "@/tool/webfetch"
import { BrowserBlocked, type Block } from "./blocked"
import { BrowserSnapshot, type SnapshotResult } from "./snapshot"
import type { Handoff, Interface, Status } from "./session"
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

/** What the model is told after a page left for the person's own browser. */
export function renderHandoff(input: { url: string; title?: string; reason?: string; handoff: Handoff }) {
  const { handoff } = input
  const where = handoff.browser ? `the user's ${handoff.browser} browser` : "the user's default browser"
  const cause = input.reason ? "The site blocked the built-in browser. " : ""
  const lines = [`url: ${input.url}`]
  if (input.title !== undefined) lines.push(`title: ${input.title || "(untitled)"}`)
  if (input.reason) lines.push(`blocked: ${input.reason}`)
  lines.push("")
  if (handoff.opened) {
    lines.push(`${cause}The page was opened in a new tab of ${where}, where they are signed in as themselves.`)
    lines.push("You cannot see or control that tab. Tell the user the page is open there and leave this site to them.")
    if (input.reason) lines.push("Do not retry it in the built-in browser: the block will not go away.")
  } else if (handoff.error) {
    lines.push(`${cause}Opening it in ${where} failed: ${handoff.error}`)
    lines.push("Tell the user to open the url themselves. Do not retry it in the built-in browser.")
  } else {
    lines.push(`${cause}This site was already opened in ${where} a few minutes ago, so no new tab was opened.`)
    lines.push("Tell the user to continue there. Do not keep retrying it in the built-in browser.")
  }
  return lines.join("\n")
}

/**
 * Checks whether the page the tab landed on is a bot wall, and if so hands it
 * to the person's own browser. `requested` is the page the agent asked for,
 * which is what should be handed over rather than the challenge it led to;
 * `known` skips the check when the block is already certain.
 */
export const handOver = Effect.fn("BrowserPage.handOver")(function* (
  browser: Interface,
  tab: Tab,
  requested?: string,
  known?: Block,
) {
  const block = known ?? (yield* Effect.promise(() => BrowserBlocked.check(tab)))
  if (!block) return undefined
  const current = yield* Effect.promise(() => tab.url())
  const title = known ? undefined : yield* Effect.promise(() => tab.title())
  const url = requested ?? BrowserBlocked.wanted(current)
  tab.announce("handoff", url)
  const handoff = yield* browser.handoff(url, { once: true })
  return {
    url,
    block,
    handoff,
    output: renderHandoff({ url, title, reason: block.reason, handoff }),
  }
})

export * as BrowserPage from "./page"
