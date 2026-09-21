import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { structuredPatch } from "diff"
import { convertHTMLToMarkdown } from "@/tool/webfetch"
import { BrowserBlocked, type Block } from "./blocked"
import { BrowserPdf } from "./pdf"
import { BrowserSnapshot, type SnapshotResult } from "./snapshot"
import { BrowserTrace } from "./trace"
import { ActionVerifier, type Verdict } from "./verify"
import type { Handoff, Interface, Status } from "./session"
import { isPreDispatch, type ConsoleEntry, type Modifier, type NetworkEntry, type Tab } from "./tab"

/** Everything the agent can do on a page, shared by browser_act and browser_batch. */
export const ACTIONS = [
  "click",
  "double_click",
  "right_click",
  "hover",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "scroll",
  "drag",
  "mouse_down",
  "mouse_up",
  "upload_file",
  "wait_for",
] as const

export type Action = (typeof ACTIONS)[number]

/** One page action, as both tools take it. */
export interface Step {
  action: Action
  ref?: string
  selector?: string
  text?: string
  submit?: boolean
  direction?: "up" | "down" | "left" | "right"
  amount?: number
  /** Keys held while clicking or pressing the button, such as Control or Shift. */
  modifiers?: readonly Modifier[]
  /** Where a drag ends: a ref from the outline. */
  to_ref?: string
  /** Where a drag ends, for elements the outline did not surface. Ignored when `to_ref` is given. */
  to_selector?: string
  /** Absolute path of the file to put into a file input. */
  file?: string
  /** Seconds. */
  timeout?: number
}

/** Actions that cannot do anything without knowing which element they mean. */
const NEEDS_TARGET = new Set<Action>([
  "click",
  "double_click",
  "right_click",
  "hover",
  "fill",
  "select",
  "check",
  "uncheck",
  "drag",
  "upload_file",
])

/**
 * A diff is only worth it while it is much shorter than the outline itself;
 * past that, or past this many changed lines, the whole outline says it better.
 */
const DIFF_LINES = 200
const DIFF_SHARE = 0.6

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

function withoutHash(url: string) {
  const index = url.indexOf("#")
  return index < 0 ? url : url.slice(0, index)
}

/**
 * What an action did to the page, relative to the last outline the model saw.
 * Refs are stable, so the model still holds a valid picture of everything that
 * did not change; sending it again would only cost time and context. A new
 * page, or a change that rewrote most of it, gets the whole outline instead.
 */
export function renderChange(previous: SnapshotResult | undefined, next: SnapshotResult) {
  if (!previous || withoutHash(previous.url) !== withoutHash(next.url)) return render(next)
  const header = [`url: ${next.url}`, `title: ${next.title || "(untitled)"}`]
  if (previous.outline === next.outline) return [...header, "", "No visible change on the page."].join("\n")

  const patch = structuredPatch("before", "after", `${previous.outline}\n`, `${next.outline}\n`, "", "", {
    context: 1,
  })
  const lines: string[] = []
  let changed = 0
  for (const hunk of patch.hunks) {
    lines.push("@@")
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue
      if (line.startsWith("+") || line.startsWith("-")) changed++
      lines.push(line)
    }
  }
  const full = render(next)
  if (changed > DIFF_LINES) return full
  if (next.truncated) header.push("note: outline truncated, raise maxNodes to see the rest")
  const diff = [
    ...header,
    "",
    "Changes to the page outline (unified diff: + added, - removed). Refs you already have still work.",
    ...lines,
  ].join("\n")
  return diff.length < full.length * DIFF_SHARE ? diff : full
}

/** The whole outline, which also becomes what later actions are compared against. */
export function outline(tab: Tab, result: SnapshotResult) {
  tab.baseline = result
  return withDialogs(tab, render(result))
}

/** What dialogs the page opened, which were answered on the model's behalf. */
function withDialogs(tab: Tab, text: string) {
  const dialogs = tab.takeDialogs()
  if (dialogs.length === 0) return text
  const lines = dialogs.map(
    (dialog) =>
      `note: the page showed a ${dialog.type} dialog${dialog.message ? ` saying "${dialog.message}"` : ""}; it was ${dialog.accepted ? "accepted" : "dismissed"}.`,
  )
  return [...lines, text].join("\n")
}

/**
 * What changed since the model last saw the page, which then becomes the new
 * reference. `full` says the whole outline was sent rather than a diff.
 */
export function changes(tab: Tab, result: SnapshotResult) {
  const previous = tab.baseline
  const change = renderChange(previous, result)
  tab.baseline = result
  return {
    output: withDialogs(tab, change),
    full: change === render(result),
    /** Whether the outline came out different at all, which is the broadest sign an action did something. */
    changed: previous?.outline !== result.outline,
  }
}

/** A short label for an action, for titles and batch reports. */
export function describe(step: Step) {
  return `${step.action} ${step.ref ?? step.selector ?? step.text ?? ""}`.trim()
}

/**
 * How often an action may be attempted. A second attempt only ever happens
 * when the first provably never reached the page, so this is not a retry of a
 * click that may have landed: it is a second look at a page that moved.
 */
const MAX_ATTEMPTS = 2

/**
 * What an action knows about its own outcome, which no amount of reading the
 * page afterwards could tell. A scroll is the case in point: a page that did
 * not move looks exactly like a page that had nothing to show.
 */
interface Effects {
  signals: string[]
  /** True when the action itself proved it did something. */
  confirmed?: boolean
}

/** Carries out one step. Everything around it - probing, settling, retrying - is `perform`'s. */
async function run(tab: Tab, step: Step, selector: string | undefined, wait: number): Promise<Effects> {
  switch (step.action) {
    case "click":
      await tab.click(selector!, "left", 1, step.modifiers)
      break
    case "double_click":
      await tab.click(selector!, "left", 2, step.modifiers)
      break
    case "right_click":
      await tab.click(selector!, "right", 1, step.modifiers)
      break
    case "hover":
      await tab.hover(selector!)
      break
    case "fill": {
      const filled = await tab.fill(selector!, step.text ?? "")
      if (step.submit) await tab.press("Enter", selector)
      // Worth saying: a field that had to be typed into rewrites what it is
      // given, so what is in it now may not be the text that was asked for.
      return {
        signals: filled.typed
          ? ["the field takes keystrokes rather than pasted text, so it was typed into key by key"]
          : [],
      }
    }
    case "type":
      await tab.type(selector, step.text ?? "")
      if (step.submit) await tab.press("Enter")
      break
    case "press":
      await tab.press(step.text || "Enter", selector)
      break
    case "select":
      await tab.select(selector!, step.text ?? "")
      break
    case "check":
      await tab.setChecked(selector!, true)
      break
    case "uncheck":
      await tab.setChecked(selector!, false)
      break
    case "scroll": {
      // Strict function calling fills omitted numbers with 0; that means the default.
      const amount = step.amount || 600
      const direction = step.direction ?? "down"
      const x = direction === "right" ? amount : direction === "left" ? -amount : 0
      const y = direction === "down" ? amount : direction === "up" ? -amount : 0
      const result = await tab.scroll(selector, x, y)
      if (!result.moved) {
        return {
          signals: [
            selector
              ? "nothing scrolled: that element and everything around it stayed where they were, so it is probably not what scrolls"
              : "nothing scrolled: the page did not move, so it is either already at the end or something else on it scrolls",
          ],
        }
      }
      return { signals: [`it scrolled ${direction}`], confirmed: true }
    }
    case "drag": {
      const destination = selectorFor({ ref: step.to_ref, selector: step.to_selector })
      if (!destination) throw new Error("The drag action needs to_ref or to_selector, saying where to drop.")
      await tab.drag(selector!, destination)
      break
    }
    case "mouse_down":
      await tab.mouseDown(selector, "left", step.modifiers)
      break
    case "mouse_up":
      await tab.mouseUp(selector, "left", step.modifiers)
      break
    case "upload_file": {
      const file = step.file?.trim()
      if (!file) throw new Error("The upload_file action needs `file`, the absolute path of the file to attach.")
      if (!path.isAbsolute(file)) throw new Error(`${file} is not an absolute path.`)
      const stat = fs.statSync(file, { throwIfNoEntry: false })
      if (!stat) throw new Error(`There is no file at ${file}.`)
      if (!stat.isFile()) throw new Error(`${file} is not a file.`)
      await tab.upload(selector!, [file])
      return { signals: [`the file was attached to the field`], confirmed: true }
    }
    case "wait_for":
      await tab.waitFor({ selector, text: step.text }, wait)
      break
  }
  return { signals: [] }
}

/**
 * Runs one action on the page, waits for what it set off to settle, and says
 * what it did.
 *
 * The page is read once before the action and once after it has settled, so
 * what comes back is what changed rather than the fact that a click was sent.
 * `timeout` is in milliseconds.
 *
 * An action that failed without ever reaching the page - the element was not
 * there, or something covered it - is attempted once more, after letting the
 * page go still. That is deliberately not a whitelist of "safe" actions: the
 * guarantee is that nothing was dispatched, so even submitting a form or
 * pressing "Delete" cannot happen twice this way. Anything that fails after
 * the press is reported as it is.
 */
export async function perform(tab: Tab, step: Step, timeout: number): Promise<Verdict> {
  const selector = selectorFor(step)
  if (NEEDS_TARGET.has(step.action) && !selector) {
    throw new Error(`The ${step.action} action needs a ref or a selector.`)
  }
  if (step.action === "wait_for" && !selector && !step.text) {
    throw new Error("The wait_for action needs a ref, a selector or text to wait for.")
  }
  const wait = step.timeout ? step.timeout * 1000 : timeout
  // Waiting is an observation, not an action: there is nothing for it to have done.
  const watching = step.action === "wait_for"

  let attempt = 0
  for (;;) {
    attempt++
    const started = Date.now()
    if (BrowserTrace.enabled) tab.trace = { requested: describe(step), attempt }
    const mark = tab.mark()
    const before = watching ? undefined : await ActionVerifier.probe(tab, selector)
    let effects: Effects
    try {
      effects = await run(tab, step, selector, wait)
    } catch (error) {
      // Nothing was dispatched, so the page is as it was: let it go still, in
      // case a banner was on its way out, and look for the element again.
      if (attempt < MAX_ATTEMPTS && isPreDispatch(error)) {
        await tab.quiet()
        continue
      }
      record(tab, step, started, attempt, { outcome: "failed", signals: [] })
      throw error
    }
    if (!watching && step.action !== "hover") await tab.settle(mark, wait)
    const verdict = watching
      ? { outcome: "success_confirmed" as const, signals: ["what it waited for is on the page"] }
      : ActionVerifier.compare({
          tab,
          mark,
          before,
          after: await ActionVerifier.probe(tab, selector),
          targeted: selector !== undefined,
          extra: effects.signals,
          confirmed: effects.confirmed,
        })
    const result = attempt > 1 ? { ...verdict, attempts: attempt } : verdict
    record(tab, step, started, attempt, result)
    return result
  }
}

/** Closes the trace entry the tab started while aiming, when tracing is on at all. */
function record(tab: Tab, step: Step, started: number, attempt: number, verdict: Verdict) {
  if (!BrowserTrace.enabled) return
  BrowserTrace.record({
    ...tab.trace,
    requested: describe(step),
    attempt,
    result: verdict.outcome,
    domChange: verdict.outcome === "success_confirmed" || verdict.outcome === "target_changed",
    navigation: verdict.outcome === "navigation",
    duration: Date.now() - started,
  })
  tab.trace = undefined
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

/** Reads a PDF, turning a failure into text the model can relay rather than an error. */
export async function readPdf(url: string, tab?: Tab) {
  return BrowserPdf.read(url, tab?.connected ? tab : undefined).catch(
    (error: unknown) =>
      `url: ${url}\ntype: PDF\n\n${error instanceof Error ? error.message : String(error)} Tell the user to open it themselves.`,
  )
}

/**
 * When an action or a navigation landed on a PDF: its text, read directly,
 * and the tab taken back to the page it was on so the agent can carry on.
 * `before` is the PDF the tab was already showing, which is not news.
 */
export const landedOnPdf = Effect.fn("BrowserPage.landedOnPdf")(function* (
  browser: Interface,
  tab: Tab,
  before?: string,
) {
  const url = tab.pdf
  if (!url || url === before) return undefined
  // Read before leaving: in the browser's own viewer the page still has the
  // site's session for a file behind a login.
  const text = yield* Effect.promise(() => readPdf(url, tab))
  const back = yield* browser.leavePdf(tab)
  const mode = yield* browser.mode()
  const note = back
    ? "It was a PDF, so its text is above; the tab went back to the page it was on, where you can carry on."
    : mode === "extension"
      ? "It was a PDF, so its text is above. The PDF stays open in the user's browser, out of your reach; your next browser action continues in another tab."
      : "It was a PDF, so its text is above; going back to the previous page failed, so navigate to continue."
  return { url, output: [text, "", note].join("\n") }
})

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
  // Driving the person's own browser there is nowhere else to go: the page is
  // already in it, and handing it over would only open it a second time.
  if ((yield* browser.mode()) === "extension") return undefined
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
