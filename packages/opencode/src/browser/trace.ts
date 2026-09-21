/**
 * An optional record of what the agent did to a page, for debugging clicks.
 *
 * A click that lands in the wrong place leaves nothing behind: the coordinates
 * were computed inside the page, used once, and forgotten. This keeps them,
 * with the rect before and after revalidation, so a misplaced click can be told
 * apart from a page that moved under it.
 *
 * Off unless `OPENCODE_BROWSER_TRACE` is set, and the cost of being off is one
 * boolean read at each call site: every entry is built inside `if (enabled)`.
 * It never records what a page says, only where things were and what happened,
 * so a traced session cannot leak a password or the text of a private page.
 */

export const enabled = process.env["OPENCODE_BROWSER_TRACE"] === "1" || process.env["OPENCODE_BROWSER_TRACE"] === "true"

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Entry {
  /** What was asked for, such as `click(ref_12)`. */
  requested: string
  /** The element's accessible name, which the model and the live view already see. Never a field's value. */
  element?: string
  initial?: Rect
  /** How long the cursor's glide took, which is the window the page had to move in. */
  cursor?: number
  /** The rect measured again after the glide, just before the press. */
  revalidated?: Rect
  final?: { x: number; y: number }
  /** How far the point moved between the two measurements, in CSS pixels. */
  drift?: number
  viewport?: { width: number; height: number }
  scroll?: { x: number; y: number }
  dpr?: number
  cdp?: string
  result?: string
  domChange?: boolean
  navigation?: boolean
  attempt?: number
  /** Milliseconds from the first measurement to the end of the action. */
  duration?: number
  note?: string
}

let counter = 0

function round(value: number) {
  return Math.round(value * 10) / 10
}

function rect(value: Rect | undefined) {
  if (!value) return undefined
  return [`x=${round(value.x)}`, `y=${round(value.y)}`, `w=${round(value.width)}`, `h=${round(value.height)}`]
}

/**
 * Writes one entry. Returns at once when tracing is off, so a caller that
 * cannot guard the call still pays almost nothing.
 */
export function record(entry: Entry) {
  if (!enabled) return
  counter++
  const lines: string[] = [`Browser Action #${counter}`, "", "requested:", `  ${entry.requested}`]
  const put = (label: string, value: string | string[] | undefined) => {
    if (value === undefined) return
    lines.push("", `${label}:`)
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`  ${item}`)
  }
  put("element", entry.element)
  put("initial rect", rect(entry.initial))
  put("cursor duration", entry.cursor === undefined ? undefined : `${entry.cursor}ms`)
  put("revalidated rect", rect(entry.revalidated))
  put("final point", entry.final ? `x=${round(entry.final.x)} y=${round(entry.final.y)}` : undefined)
  put("drift", entry.drift === undefined ? undefined : `${round(entry.drift)}px`)
  put("viewport", entry.viewport ? `${entry.viewport.width}x${entry.viewport.height}` : undefined)
  put("scroll", entry.scroll ? `${round(entry.scroll.x)}, ${round(entry.scroll.y)}` : undefined)
  put("DPR", entry.dpr === undefined ? undefined : String(entry.dpr))
  put("CDP", entry.cdp)
  put("attempt", entry.attempt === undefined ? undefined : String(entry.attempt))
  put("result", entry.result)
  put("DOM change", entry.domChange === undefined ? undefined : entry.domChange ? "yes" : "no")
  put("navigation", entry.navigation === undefined ? undefined : entry.navigation ? "yes" : "no")
  put("duration", entry.duration === undefined ? undefined : `${Math.round(entry.duration)}ms`)
  put("note", entry.note)
  process.stderr.write(`${lines.join("\n")}\n\n`)
}

export * as BrowserTrace from "./trace"
