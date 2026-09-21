import { createEffect, createSignal, onCleanup } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

/**
 * Time left for the request in progress, as the server estimates it from the
 * person's own history and the agent's todo list. Asked for every few
 * seconds; between answers it counts down on its own, so the readout moves
 * smoothly instead of jumping at each poll.
 */

const POLL_MS = 5000

export interface Eta {
  elapsed: number
  remaining?: number
  basis?: "plan" | "history"
  typical?: number
  runs: number
  todos?: { total: number; done: number }
}

export function createEta(input: { sessionID: () => string | undefined; active: () => boolean }) {
  const server = useServer()
  const platform = usePlatform()
  const [answer, setAnswer] = createSignal<{ eta: Eta; at: number }>()
  const [now, setNow] = createSignal(Date.now())

  const load = (sessionID: string) => {
    const connection = server.current
    if (!connection) return
    const url = new URL("/experimental/usage/eta", connection.http.url)
    url.searchParams.set("sessionID", sessionID)
    const headers: Record<string, string> = {}
    if (connection.http.password)
      headers.Authorization = `Basic ${authTokenFromCredentials({ username: connection.http.username, password: connection.http.password })}`
    void (platform.fetch ?? fetch)(url, { headers })
      .then((response) => (response.ok ? (response.json() as Promise<Eta>) : undefined))
      .then((eta) => {
        if (eta && Number.isFinite(eta.elapsed)) setAnswer({ eta, at: Date.now() })
      })
      .catch(() => undefined)
  }

  createEffect(() => {
    const sessionID = input.sessionID()
    if (!input.active() || !sessionID) {
      setAnswer(undefined)
      return
    }
    load(sessionID)
    const poll = setInterval(() => load(sessionID), POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => {
      clearInterval(poll)
      clearInterval(tick)
    })
  })

  return {
    eta: () => answer()?.eta,
    /** Milliseconds left right now, counted down since the last answer. */
    remaining: () => {
      const current = answer()
      if (current?.eta.remaining === undefined) return undefined
      return Math.max(0, current.eta.remaining - (now() - current.at))
    },
  }
}

/** "< 1 min", "~4 min", "~1 h 10 min". */
export function formatRemaining(ms: number) {
  const minutes = Math.round(ms / 60_000)
  if (ms < 45_000) return "< 1 min"
  if (minutes < 60) return `~${Math.max(1, minutes)} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `~${hours} h ${rest} min` : `~${hours} h`
}
