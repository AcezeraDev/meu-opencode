import { createSignal, onCleanup, onMount } from "solid-js"

/**
 * The day's dollar-to-real rate, so spend reads in the currency it is paid in.
 * Model prices are in dollars; a figure like "$0.0011" means little to someone
 * who pays in reais. Two free sources, the second as a fallback, and the value
 * is cached for hours: a rate a few hours old is plenty for a spend readout.
 */

const CACHE_KEY = "opencode.scope.usd-brl"
const MAX_AGE = 6 * 60 * 60 * 1000
const RETRY = 10 * 60 * 1000

interface Cached {
  rate: number
  at: number
}

function cached(): Cached | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Cached | null
    if (value && Number.isFinite(value.rate) && value.rate > 0) return value
  } catch {
    // No storage, or something unreadable in it: fetch instead.
  }
  return undefined
}

function remember(rate: number) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ rate, at: Date.now() }))
  } catch {
    // Without storage the rate is fetched again next time; that is fine.
  }
}

async function fetchRate(): Promise<number | undefined> {
  const sources: [string, (body: any) => unknown][] = [
    ["https://economia.awesomeapi.com.br/json/last/USD-BRL", (body) => body?.USDBRL?.bid],
    ["https://open.er-api.com/v6/latest/USD", (body) => body?.rates?.BRL],
  ]
  for (const [url, pick] of sources) {
    const rate = await fetch(url, { signal: AbortSignal.timeout(8000) })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body) => Number(pick(body)))
      .catch(() => Number.NaN)
    if (Number.isFinite(rate) && rate > 0) return rate
  }
  return undefined
}

/** The current USD→BRL rate, or undefined until one is known. Stale cache is used while refreshing. */
export function createUsdBrlRate() {
  const initial = cached()
  const [rate, setRate] = createSignal<number | undefined>(initial?.rate)
  let timer: ReturnType<typeof setTimeout> | undefined

  const refresh = async () => {
    const known = cached()
    if (known && Date.now() - known.at < MAX_AGE) {
      setRate(known.rate)
      timer = setTimeout(refresh, MAX_AGE - (Date.now() - known.at))
      return
    }
    const fresh = await fetchRate()
    if (fresh) {
      remember(fresh)
      setRate(fresh)
    }
    timer = setTimeout(refresh, fresh ? MAX_AGE : RETRY)
  }

  onMount(() => void refresh())
  onCleanup(() => clearTimeout(timer))
  return rate
}
