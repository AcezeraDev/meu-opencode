import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform, type Platform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"

/**
 * Every session has a tone of its own inside its project's color: the same
 * space, turned a little either way along the hue, or softened
 * (`spaces.css`, `[data-tone]`). The app keeps wearing the project's space; the
 * tone marks which session a tab or a row is, so sessions of one project tell
 * apart at a glance.
 *
 * A session gets its tone the first time its tab opens: the first one that no
 * other open tab of the same project wears, starting from a hash of its ID so
 * the choice is stable. The person can pick another from the tab's menu.
 */
export const SESSION_TONES = 6

let shared: ReturnType<typeof create> | undefined

export function useSessionTones() {
  const platform = usePlatform()
  shared ??= createRoot(() => create(platform))
  return shared
}

function create(platform: Platform) {
  const [store, setStore] = persisted(
    Persist.global("session.tone"),
    createStore({ tones: {} as Record<string, number> }),
    platform,
  )
  // The open tabs and the project each belongs to, for picking tones that differ.
  const [open, setOpen] = createStore<Record<string, string | undefined>>({})
  const tone = (sessionID: string) => store.tones[sessionID] ?? hashed(sessionID)
  return {
    tone,
    set: (sessionID: string, next: number) => setStore("tones", sessionID, next),
    /** Registers an open tab; a session without a tone takes one its open siblings do not wear. */
    open(sessionID: string, project: string) {
      setOpen(sessionID, project)
      if (store.tones[sessionID] !== undefined) return
      const used = new Set(
        Object.entries(open)
          .filter(([id, key]) => id !== sessionID && key === project)
          .map(([id]) => tone(id)),
      )
      const start = hashed(sessionID)
      const free = Array.from({ length: SESSION_TONES }, (_, step) => (start + step) % SESSION_TONES).find(
        (candidate) => !used.has(candidate),
      )
      setStore("tones", sessionID, free ?? start)
    },
    close: (sessionID: string) => setOpen(sessionID, undefined),
  }
}

function hashed(sessionID: string) {
  const hash = [...sessionID].reduce((sum, char) => (Math.imul(sum, 31) + char.charCodeAt(0)) | 0, 11)
  return Math.abs(hash) % SESSION_TONES
}
