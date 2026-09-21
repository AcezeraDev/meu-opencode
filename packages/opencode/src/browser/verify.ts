/**
 * What an action actually did.
 *
 * Dispatching a click is not the same as the click having done something: the
 * coordinates can be right and the page still ignore it, and until now the
 * model was told "click succeeded" either way and had to guess from the diff.
 * So the element and the page are read once just before the action and once
 * after it has settled, and the difference between the two readings is what the
 * model is told.
 *
 * Not every click is supposed to change the page — closing an already closed
 * menu, ticking a box that was ticked, clicking a label — so "nothing changed"
 * is reported as its own outcome rather than as a failure. The model decides
 * whether that was what it wanted.
 *
 * Nothing here reads what a page says. A field's value is compared through a
 * one-way signature, so a password can be known to have changed without its
 * text ever leaving the page.
 */

import type { Mark, Tab } from "./tab"

export type Outcome =
  /** The page went somewhere else. */
  | "navigation"
  /** Something observable changed: a value, a state, the focus, the outline. */
  | "success_confirmed"
  /** The action ran and nothing observable changed, which is not always wrong. */
  | "success_no_visible_change"
  /** The element that was acted on is no longer on the page. */
  | "target_changed"
  /** The action could not be carried out. */
  | "failed"
  /** The page could not be read afterwards, so nothing can be claimed. */
  | "uncertain"

/** One reading of the element and the page around it. */
export interface Probe {
  url: string
  /** Whether the targeted element is on the page. True when nothing was targeted. */
  present: boolean
  checked?: boolean
  selected?: boolean
  expanded?: boolean
  /** A one-way signature of the field's value, so a change can be seen without reading it. */
  value?: number
  /** What has focus, as a short shape such as `input#email`. Never a value. */
  active: string
  /** Whether what has focus is the element being acted on, or something inside it. */
  focusedTarget?: boolean
  /** Dialogs answered but not yet reported, which only ever grows within one action. */
  dialogs: number
}

export interface Verdict {
  outcome: Outcome
  /** Short phrases naming what changed, in the order they matter. */
  signals: string[]
  /** How many times the action had to be attempted, when more than once. */
  attempts?: number
}

/**
 * Runs in the page. The element is looked up with the same finder the actions
 * use, so a ref inside a frame reads the very element that was clicked.
 */
function script(locate: string) {
  return `(() => {
    const el = ${locate}
    const doc = el ? el.ownerDocument : document
    const active = doc.activeElement
    const shape = (node) => {
      if (!node || !node.tagName) return ""
      return node.tagName.toLowerCase() + (node.id ? "#" + node.id : "")
    }
    // A one-way signature: enough to see that a value changed, never enough to
    // read it back.
    const sign = (text) => {
      let hash = 0
      for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0
      return hash
    }
    const attr = (name) => {
      const value = el && el.getAttribute ? el.getAttribute(name) : null
      return value === "true" ? true : value === "false" ? false : undefined
    }
    const out = {
      url: document.location.href,
      present: !!el,
      active: shape(active),
    }
    if (!el) return out
    out.focusedTarget = !!active && (active === el || el.contains(active))
    out.checked = typeof el.checked === "boolean" ? el.checked : attr("aria-checked")
    out.selected = attr("aria-selected")
    out.expanded = attr("aria-expanded")
    if (typeof el.value === "string") out.value = sign(el.value)
    else if (el.isContentEditable) out.value = sign(el.innerText || "")
    return out
  })()`
}

/** Reads the element and the page. Never throws: an unreadable page is its own answer. */
export async function probe(tab: Tab, selector?: string): Promise<Probe | undefined> {
  return tab
    .evaluate<Probe>(script(selector ? tab.locate(selector) : "null"))
    .then((result) => ({ ...result, dialogs: tab.dialogCount }))
    .catch(() => undefined)
}

/**
 * Compares a reading taken before the action with one taken after it settled.
 * `outlineChanged` comes from whoever holds the page outline, since that is
 * computed once by the caller and is the broadest signal there is.
 */
export function compare(input: {
  tab: Tab
  mark: Mark
  before?: Probe
  after?: Probe
  targeted: boolean
  outlineChanged?: boolean
  /**
   * What the action itself observed, which reading the page cannot recover: a
   * scroll that moved nothing looks just like a page with nothing to show.
   * These are reported but do not confirm anything on their own, since some of
   * them say that nothing happened.
   */
  extra?: string[]
  /** Set when the action proved it did something, whatever the page reads like now. */
  confirmed?: boolean
}): Verdict {
  const { tab, mark, before, after, targeted } = input
  const told = input.extra ?? []
  // Kept apart from what the action reported, because only these decide
  // whether anything actually changed.
  const detected: string[] = []
  const signals = () => [...told, ...detected]

  if (tab.navigatedSince(mark) || (before && after && before.url !== after.url)) {
    detected.push(after ? `the page is now ${after.url}` : "the page navigated")
    return { outcome: "navigation", signals: signals() }
  }
  if (!before || !after) {
    return { outcome: "uncertain", signals: [...told, "the page could not be read after the action"] }
  }
  if (after.dialogs > before.dialogs) detected.push("the page opened a dialog, which was answered")
  if (targeted && before.present && !after.present) {
    detected.push("the element that was acted on is no longer on the page")
    return { outcome: "target_changed", signals: signals() }
  }
  if (before.checked !== after.checked && after.checked !== undefined) detected.push(`it is now ${after.checked ? "checked" : "unchecked"}`)
  if (before.selected !== after.selected && after.selected !== undefined) detected.push(`it is now ${after.selected ? "selected" : "unselected"}`)
  if (before.expanded !== after.expanded && after.expanded !== undefined) detected.push(`it is now ${after.expanded ? "expanded" : "collapsed"}`)
  if (before.value !== after.value) detected.push("the field's value changed")
  // Clicking something focusable focuses it; saying so for every click would
  // drown the signal and make "nothing changed" almost unreachable. Focus is
  // only news when it went somewhere other than what was acted on, which is
  // what a dialog opening or a form moving on looks like.
  if (before.active !== after.active && !(targeted && after.focusedTarget)) {
    detected.push(after.active ? `focus moved to ${after.active}` : "focus left the page")
  }
  if (input.outlineChanged) detected.push("the page outline changed")

  const confirmed = input.confirmed === true || detected.length > 0
  return { outcome: confirmed ? "success_confirmed" : "success_no_visible_change", signals: signals() }
}

/** Folds in what only the caller knows: whether the page outline came out different. */
export function withOutline(verdict: Verdict, changed: boolean): Verdict {
  if (!changed || verdict.outcome !== "success_no_visible_change") return verdict
  return { ...verdict, outcome: "success_confirmed", signals: [...verdict.signals, "the page outline changed"] }
}

/** The one line the model reads before the diff. */
export function render(label: string, verdict: Verdict) {
  const tried = verdict.attempts && verdict.attempts > 1 ? ` (on attempt ${verdict.attempts})` : ""
  const detail = verdict.signals.length > 0 ? `: ${verdict.signals.join("; ")}` : ""
  switch (verdict.outcome) {
    case "navigation":
      return `${label} ran${tried} and took the browser to another page${detail}.`
    case "success_confirmed":
      return `${label} ran${tried} and the page reacted${detail}.`
    case "target_changed":
      return `${label} ran${tried}${detail}. That is usually what a click that closes or removes something looks like.`
    case "success_no_visible_change":
      return `${label} ran${tried}, but nothing observable changed on the page. If you expected it to do something, check the outline below before acting again.`
    case "uncertain":
      return `${label} was sent${tried}, but the page could not be read afterwards, so there is no telling what it did.`
    case "failed":
      return `${label} did not run${detail}.`
  }
}

export * as ActionVerifier from "./verify"
