import { createEffect, createRoot, createSignal, on } from "solid-js"
import { useLynxPrefs } from "@/context/lynx-prefs"
import { useSettings } from "@/context/settings"

export type Change = {
  /** Where the value lives: "settings" (the app's settings) or "lynx" (Lynx Code looks). */
  scope: "settings" | "lynx"
  path: string[]
  from: unknown
  to: unknown
  at: number
}

const KEY = "lynx.settings.history"
const LIMIT = 60
// Bookkeeping and per-visit values that are not choices anyone made.
const IGNORED = ["homeSeen", "layoutTransitionEligible", "agentVisibilityInitialized", "shouldDisplayTabsToast"]

let shared: ReturnType<typeof create> | undefined

/**
 * Every setting that changes, what it was and what it became, newest first,
 * kept on this computer so a change can be undone later from the history.
 */
export function useSettingsHistory() {
  const settings = useSettings()
  const prefs = useLynxPrefs()
  shared ??= createRoot(() => create(settings, prefs))
  return shared
}

function create(settings: ReturnType<typeof useSettings>, prefs: ReturnType<typeof useLynxPrefs>) {
  const [list, setList] = createSignal<Change[]>(load())
  let undoing = false

  const record = (scope: Change["scope"], before: unknown, after: unknown) => {
    if (undoing) return
    const found = diff(before, after, [])
      .filter((item) => !IGNORED.includes(item.path.at(-1) ?? ""))
      .map((item) => ({ ...item, scope, at: Date.now() }))
    if (!found.length) return
    const next = [...found, ...list()].slice(0, LIMIT)
    setList(next)
    save(next)
  }

  createEffect(
    on(
      () => JSON.stringify(settings.current),
      (now, before) => before !== undefined && settings.ready() && record("settings", JSON.parse(before), JSON.parse(now)),
    ),
  )
  createEffect(
    on(
      () => JSON.stringify(prefs.snapshot()),
      (now, before) => before !== undefined && record("lynx", JSON.parse(before), JSON.parse(now)),
    ),
  )

  return {
    list,
    undo(change: Change) {
      undoing = true
      if (change.scope === "lynx") prefs.set(change.path[0] as never, change.from as never)
      if (change.scope === "settings") settings.setPath(change.path, change.from)
      undoing = false
      const next = list().filter((item) => item !== change)
      setList(next)
      save(next)
    },
  }
}

function diff(before: unknown, after: unknown, path: string[]): Omit<Change, "scope" | "at">[] {
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    return [...keys].flatMap((key) => diff(before[key], after[key], [...path, key]))
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  return [{ path, from: before, to: after }]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function load(): Change[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]")
  } catch {
    return []
  }
}

function save(list: Change[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {}
}
