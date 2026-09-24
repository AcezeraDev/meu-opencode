import fs from "fs"
import path from "path"
import { Cause, Effect } from "effect"
import { diffArrays, structuredPatch } from "diff"
import { convertHTMLToMarkdown } from "@/tool/webfetch"
import { BrowserBlocked, type Block } from "./blocked"
import { BrowserPdf } from "./pdf"
import { Docx } from "@/util/docx"
import { Office } from "@/util/office"
import { BrowserSnapshot, type SnapshotResult } from "./snapshot"
import { BrowserTrace } from "./trace"
import { ActionVerifier, type Verdict } from "./verify"
import type { Handoff, Interface, Status } from "./session"
import { isPreDispatch, type ConsoleEntry, type Modifier, type NetworkEntry, type Tab } from "./tab"

/**
 * The address to open for what the agent wrote. The outline shows links to the
 * page's own site by their path, so a path is opened on the site of the page
 * the tab is on; anything else is taken as written.
 */
export async function resolveAddress(url: string, tab?: Tab) {
  if (!/^\/(?!\/)/.test(url)) return url
  const base = tab ? await tab.url().catch(() => "") : ""
  if (!/^https?:\/\//.test(base)) {
    throw new Error(`${url} is a path on a site, and no web page is open to take the site from; give the full address.`)
  }
  return new URL(url, base).href
}

/**
 * Runs in the page: answers a cookie banner by refusing non-essential cookies,
 * and says what it clicked. Known consent tools first, by their own buttons;
 * then a button whose whole label says "refuse" inside something that is
 * plainly about cookies. Anything less certain is left alone.
 */
const REFUSE_COOKIES = `(() => {
  const refuse = /^(recusar|rejeitar|recusar tudo|recusar todos|rejeitar tudo|rejeitar todos|recusar cookies|rejeitar cookies|recusar opcionais|apenas necess[aá]rios|somente necess[aá]rios|apenas os necess[aá]rios|usar apenas (os )?cookies necess[aá]rios|continuar sem aceitar|reject|reject all|reject all cookies|decline|decline all|deny|deny all|refuse|refuse all|only necessary|necessary only|necessary cookies only|use necessary cookies only|continue without accepting|rechazar|rechazar todo|tout refuser|alle ablehnen)$/i
  const known = [
    "#onetrust-reject-all-handler",
    "#CybotCookiebotDialogBodyButtonDecline",
    "#didomi-notice-disagree-button",
    ".cky-btn-reject",
    "[data-testid='uc-deny-all-button']",
    ".fc-cta-do-not-consent",
    "#truste-consent-required",
  ]
  const shown = (el) => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none"
  }
  const label = (el) => (el.innerText || el.getAttribute("aria-label") || el.value || "").replace(/\\s+/g, " ").trim()
  for (const selector of known) {
    const button = document.querySelector(selector)
    if (button && shown(button)) {
      button.click()
      return label(button) || "refuse"
    }
  }
  const banners = [...document.querySelectorAll(
    "[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],[id*=gdpr i],[class*=gdpr i],[id*=lgpd i],[class*=lgpd i],[aria-label*=cookie i],[role=dialog],[role=alertdialog]",
  )].filter(shown)
  for (const banner of banners) {
    if (/dialog/.test(banner.getAttribute("role") || "") && !/cookie|consent|lgpd|gdpr/i.test(banner.innerText || "")) continue
    for (const button of banner.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]")) {
      const text = label(button)
      if (text.length < 60 && refuse.test(text) && shown(button)) {
        button.click()
        return text
      }
    }
  }
  return ""
})()`

/**
 * Answers a cookie banner on the page the tab just opened by refusing
 * non-essential cookies. Otherwise the banner covered what the agent came for,
 * and a step went to it, often clicking Accept. Returns a line for the model
 * when it answered one.
 */
export async function refuseCookies(tab: Tab) {
  const clicked = await tab.evaluate<string>(REFUSE_COOKIES).catch(() => "")
  if (!clicked) return undefined
  await tab.quiet(100, 800).catch(() => {})
  return `Cookie banner answered for you: clicked "${clicked}", refusing non-essential cookies.`
}

/**
 * Runs in the page: what on it is the person's to do, if anything — a
 * captcha, a password to type, card details. Only what is visible counts, and
 * a password field someone already filled does not.
 */
const NEEDS_PERSON = `(() => {
  const shown = (el) => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return box.width > 4 && box.height > 4 && style.visibility !== "hidden" && style.display !== "none"
  }
  const any = (selector) => [...document.querySelectorAll(selector)].some(shown)
  if (any("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='challenges.cloudflare.com'], .g-recaptcha, .h-captcha, .cf-turnstile")) return "captcha"
  if (any("input[autocomplete^='cc-'], input[name*='cardnumber' i], input[name*='card_number' i], input[data-card-number]")) return "payment"
  if ([...document.querySelectorAll("input[type=password]")].some((el) => shown(el) && !el.value)) return "password"
  return ""
})()`

const NEEDS = {
  captcha: "a captcha",
  password: "a password",
  payment: "card or payment details",
}

/**
 * A line for the model when the page it landed on asks for something that is
 * the person's to give: it should not type a password or card for them, nor
 * try to beat a captcha, but hand the page to them and wait.
 */
export async function personNeeded(tab: Tab) {
  const found = (await tab.evaluate<string>(NEEDS_PERSON).catch(() => "")) as keyof typeof NEEDS | ""
  if (!found) return undefined
  return `This page asks for ${NEEDS[found]}, which is the user's to do: do not type their password or card details, nor try to solve a captcha. Call browser_navigate with action "ask_user" and a short reason; the user does it in the browser and you carry on after.`
}

/** What a tool call fails with when the browser extension went away under it. */
const DROPPED = /browser extension disconnected|extension not connected|can no longer be controlled/i

/** Whether a tool call failed because the browser extension dropped out while it ran. */
export function dropped(cause: Cause.Cause<unknown>) {
  return DROPPED.test(String(Cause.squash(cause)))
}

/**
 * Runs a read of the page again once when the extension dropped out under it:
 * reading twice changes nothing, and the tab is still there when it is back.
 */
export function retryDropped<A, E, R>(read: Effect.Effect<A, E, R>) {
  return read.pipe(Effect.catchCause((cause) => (dropped(cause) ? read : Effect.failCause(cause))))
}

/**
 * An action cut off by the extension dropping out is not repeated: a click
 * may already have happened. The model is told what to do instead, since in
 * real sessions it reloaded the page and lost the answers it had chosen.
 */
export function explainDropped<A, E, R>(action: Effect.Effect<A, E, R>) {
  return action.pipe(
    Effect.catchCause((cause) =>
      dropped(cause)
        ? Effect.die(
            new Error(
              "The browser extension dropped out while this ran and is back; the tab was kept as it was, not reloaded. The action may or may not have happened: call browser_snapshot to see the page, then carry on from there. Do not reload the page, which would lose answers already chosen.",
            ),
          )
        : Effect.failCause(cause),
    ),
  )
}

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
  tab.anchor = result
  return withDialogs(tab, render(result))
}

/**
 * The outline of a page the agent just arrived at, which also becomes what
 * later actions are compared against. `partial` says lines were left out.
 *
 * Pages of one site repeat their menus, and the repeat is most of what a new
 * page costs: on a Moodle course every page carried the same course index, a
 * hundred and fifty links, about half of each outline and some seven thousand
 * tokens a step, read again by the model at every turn after. Runs of lines
 * exactly as the last whole outline had them are left out, and the refs they
 * were shown with there keep working on the new page (31% less across 169 real
 * Moodle pages). That whole outline stays in the model's context for as long
 * as later ones lean on it (see `MessageV2`).
 */
export function landed(tab: Tab, result: SnapshotResult) {
  const anchor = tab.anchor
  // The same page again, reloaded or gone back to, is shown whole.
  const again = tab.baseline && withoutHash(tab.baseline.url) === withoutHash(result.url)
  tab.baseline = result
  const repeats = anchor && !again ? leaveOutRepeats(anchor, result) : undefined
  if (!repeats) {
    tab.anchor = result
    return { output: withDialogs(tab, render(result)), partial: false }
  }
  tab.alias(repeats.aliases)
  return { output: withDialogs(tab, render({ ...result, outline: repeats.outline })), partial: true }
}

/** A run of unchanged lines shorter than this is cheaper to repeat than to explain. */
const REPEAT_MIN_LINES = 6
const REF = /ref_\d+/g

/**
 * `next`'s outline with the runs of lines `previous` already had left out, and
 * how their refs map. Compared line by line with the refs taken out, because a
 * menu that marks the page it is on as selected differs from one page to the
 * next in that line only; compared as whole blocks, nothing was ever the same.
 */
function leaveOutRepeats(previous: SnapshotResult, next: SnapshotResult) {
  if (origin(previous.url) !== origin(next.url) || withoutHash(previous.url) === withoutHash(next.url)) return undefined
  const before = previous.outline.split("\n")
  const after = next.outline.split("\n")
  const aliases: [string, string][] = []
  let from = 0
  let to = 0
  let left = 0
  const lines = diffArrays(before.map(withoutRefs), after.map(withoutRefs)).flatMap((part) => {
    const count = part.value.length
    if (part.removed) {
      from += count
      return []
    }
    const run = after.slice(to, to + count)
    to += count
    if (part.added) return run
    const earlier = before.slice(from, from + count)
    from += count
    if (count < REPEAT_MIN_LINES) return run
    for (const [index, line] of run.entries()) {
      const now = line.match(REF) ?? []
      for (const [position, ref] of (earlier[index]?.match(REF) ?? []).entries()) {
        const current = now[position]
        if (current && current !== ref) aliases.push([ref, current])
      }
    }
    left += count - 1
    // The first line stays, so it is clear where in the page the run was.
    return [
      run[0]!,
      `${indentOf(run[1]!)}- … ${count - 1} more lines as in the last full outline of this site (the refs you saw there still work here; browser_snapshot shows them all)`,
    ]
  })
  if (left === 0) return undefined
  return { outline: lines.join("\n"), aliases }
}

function withoutRefs(line: string) {
  return line.replace(REF, "ref")
}

function indentOf(line: string) {
  return line.slice(0, line.length - line.trimStart().length)
}

function origin(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
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
  if (previous && withoutHash(previous.url) !== withoutHash(result.url)) {
    const arrived = landed(tab, result)
    return { output: arrived.output, full: true, partial: arrived.partial, changed: true }
  }
  const change = renderChange(previous, result)
  tab.baseline = result
  const full = change === render(result)
  if (full) tab.anchor = result
  return {
    output: withDialogs(tab, change),
    full,
    partial: false,
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
    const probed = Date.now()
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
    const acted = Date.now()
    if (!watching && step.action !== "hover") await tab.settle(mark, wait)
    const settled = Date.now()
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
    // Where the time went, kept with the tool call for when an action is slow.
    tab.timing = {
      probe: probed - started,
      act: acted - probed,
      settle: settled - acted,
      verify: Date.now() - settled,
    }
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
 * When an action or a navigation landed on a PDF: the file downloaded to the
 * Downloads folder, its text for the model, and the tab showing it in a
 * viewer the agent can look at, with the page it came from one step back.
 * `before` is the PDF the tab was already showing, which is not news.
 */
export const landedOnPdf = Effect.fn("BrowserPage.landedOnPdf")(function* (
  browser: Interface,
  tab: Tab,
  before?: string,
) {
  const url = tab.pdf
  if (!url || url === before) return undefined
  // Downloaded before leaving: in the browser's own viewer the page still has
  // the site's session for a file behind a login.
  const opened = yield* Effect.promise(() => openPdf(url, tab))
  // The browser's viewer is left for the page before, so that page is one
  // step back from the viewer that replaces it.
  const back = yield* browser.leavePdf(tab)
  if ("failure" in opened) return { url, output: opened.failure }
  const mode = yield* browser.mode()
  const shown = yield* showPdf(browser, opened, back || mode === "process" ? "same" : "new")
  if (shown) return { url, output: shown }
  const note = back
    ? "It was a PDF, so its text is above; the tab went back to the page it was on, where you can carry on."
    : mode === "extension"
      ? "It was a PDF, so its text is above. The PDF stays open in the user's browser, out of your reach; your next browser action continues in another tab."
      : "It was a PDF, so its text is above; going back to the previous page failed, so navigate to continue."
  return { url, output: [opened.text, "", `Saved to ${opened.file}.`, note].join("\n") }
})

/** The kinds of file the agent reads for itself when it meets one while browsing. */
export type DocumentKind = "pdf" | "docx" | "pptx" | "xlsx"

/** Which readable kind of file an address, a file name or a content type is, if any. */
export function documentKind(name: string, contentType?: string): DocumentKind | undefined {
  if (contentType) {
    if (/application\/(x-)?pdf/i.test(contentType)) return "pdf"
    if (/wordprocessingml\.document/i.test(contentType)) return "docx"
    if (/presentationml\.presentation/i.test(contentType)) return "pptx"
    if (/spreadsheetml\.sheet/i.test(contentType)) return "xlsx"
  }
  const bare = URL.canParse(name) ? new URL(name).pathname : name
  const ext = /\.(pdf|docx|pptx|xlsx)$/i.exec(bare)?.[1]?.toLowerCase()
  return ext as DocumentKind | undefined
}

const OFFICE = { docx: "a Word document", pptx: "a PowerPoint presentation", xlsx: "an Excel workbook" }

/**
 * A Word, PowerPoint or Excel file met while browsing: downloaded (with the
 * page's session when it needs one), kept in the Downloads folder and read.
 * The browser shows none of these itself, so the tab stays as it is.
 */
export async function readOffice(url: string, kind: Exclude<DocumentKind, "pdf">, tab?: Tab, name?: string) {
  const opened = await BrowserPdf.download(url, tab?.connected ? tab : undefined, Docx.isZip, OFFICE[kind]).then(
    async (bytes) => {
      const file = await BrowserPdf.save(url, bytes, undefined, name ?? BrowserPdf.fileName(url, `.${kind}`))
      const text =
        kind === "docx"
          ? [`url: ${url}`, "type: Word document", "", Docx.docxText(bytes) || "(the document has no text)"].join("\n")
          : Office.render({
              url,
              name: file,
              ...(kind === "pptx" ? { slides: Office.slides(bytes) ?? [] } : { sheets: Office.sheets(bytes) ?? [] }),
            })
      return { file, text }
    },
    (error: unknown) => ({ failure: error instanceof Error ? error.message : String(error) }),
  )
  if ("failure" in opened) return `url: ${url}\n\n${opened.failure} Tell the user to open it themselves.`
  return [opened.text, "", `It was downloaded to ${opened.file}; the tab was left as it was.`].join("\n")
}

/**
 * A file an action made the page download, read for the model: an action
 * that only downloaded something otherwise looked like it did nothing.
 */
export const readDownload = Effect.fn("BrowserPage.readDownload")(function* (
  browser: Interface,
  tab: Tab,
  since: number,
) {
  const download = tab.downloadsSince(since).findLast((item) => documentKind(item.name || item.url))
  if (!download) return undefined
  const kind = documentKind(download.name || download.url)!
  const output = yield* readDownloaded(browser, tab, download, kind)
  return { url: download.url, output }
})

const readDownloaded = Effect.fn("BrowserPage.readDownloaded")(function* (
  browser: Interface,
  tab: Tab,
  download: { url: string; name: string },
  kind: DocumentKind,
) {
  if (kind !== "pdf") return yield* Effect.promise(() => readOffice(download.url, kind, tab, download.name || undefined))
  const opened = yield* Effect.promise(() =>
    BrowserPdf.open(download.url, tab.connected ? tab : undefined, download.name || undefined).catch((error: unknown) => ({
      failure: `url: ${download.url}\ntype: PDF\n\n${error instanceof Error ? error.message : String(error)} Tell the user to open it themselves.`,
    })),
  )
  if ("failure" in opened) return opened.failure
  const shown = yield* showPdf(browser, opened, "same")
  return shown ?? [opened.text, "", `Saved to ${opened.file}.`].join("\n")
})

/** Downloads, keeps and reads a PDF, turning a failure into text the model can relay. */
export async function openPdf(url: string, tab?: Tab) {
  return BrowserPdf.open(url, tab?.connected ? tab : undefined).catch((error: unknown) => ({
    failure: `url: ${url}\ntype: PDF\n\n${error instanceof Error ? error.message : String(error)} Tell the user to open it themselves.`,
  }))
}

/**
 * Opens a downloaded PDF's viewer in the current tab or a new one and waits
 * for its pages to be drawn. What the model is told, or undefined when the
 * viewer could not be shown.
 */
export const showPdf = Effect.fn("BrowserPage.showPdf")(function* (
  browser: Interface,
  opened: { file: string; text: string; pages: number; viewer?: string },
  where: "same" | "new",
) {
  const viewer = opened.viewer
  if (!viewer) return undefined
  const timeout = yield* browser.timeout()
  const tab = where === "new" ? yield* browser.open() : yield* browser.tab()
  const ok = yield* Effect.promise(() =>
    tab
      .serialize(async () => {
        await tab.navigate(viewer, "domcontentloaded", timeout)
        // Drawing is quick, but a screenshot taken before it shows blank pages.
        const deadline = Date.now() + PDF_DRAW_WAIT
        while (Date.now() < deadline) {
          const ready = await tab.evaluate<boolean>("document.documentElement.dataset.ready === '1'").catch(() => false)
          if (ready) return true
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        return true
      })
      .catch(() => false),
  )
  if (!ok) return undefined
  return [
    opened.text,
    "",
    `The PDF was downloaded to ${opened.file} and is open in the browser tab, in a viewer with one "Página N de ${opened.pages}" heading per page. Its text is above; to look at figures, tables or pages without text, take a browser_screenshot there and scroll with browser_act. browser_navigate back returns to the page you came from.`,
  ].join("\n")
})

/** How long a PDF's viewer is given to draw its pages. */
const PDF_DRAW_WAIT = 8000

/**
 * The tab an action opened (a target=_blank link, a popup), which the browser
 * has made active. The page the action was on is left as it was, so without
 * this the agent was told its click changed nothing and kept looking there. An
 * action that visibly did nothing gets a moment for the new tab to show up.
 */
export const openedTab = Effect.fn("BrowserPage.openedTab")(function* (
  browser: Interface,
  tab: Tab,
  since: number,
  verdict?: Verdict,
) {
  if (!verdict || verdict.outcome === "navigation") return undefined
  return yield* browser.opened(tab, since, verdict.outcome === "success_no_visible_change" ? POPUP_WAIT : 300)
})

/** How long a click that changed nothing on its page is given to show up as a new tab. */
const POPUP_WAIT = 1500

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
