import type { Tab } from "./tab"

/**
 * Tells when a site has turned the built-in browser away.
 *
 * Bot walls answer a headless browser with a challenge page instead of the
 * site, and no amount of retrying gets past them. Recognising one lets the
 * page be handed to the person's own browser instead of wasting turns on it.
 *
 * Being wrong the other way is worse: a page taken for a block leaves the
 * agent's reach for no reason. So a vendor's own fingerprint is trusted on its
 * own, while wording like "Access denied" only counts on an error status or on
 * a page too short to be anything but the block itself.
 */

/** What a page shows, as read by `SCRIPT` plus the response that served it. */
export interface Signals {
  url: string
  title: string
  /** The start of the visible text, whitespace collapsed. */
  text: string
  /** Length of the whole visible text. */
  length: number
  /** Fingerprints of anti-bot vendors and captcha widgets found on the page. */
  markers: string[]
  ready?: string
  /** Status of the main document, when it is known to be this page's. */
  status?: number
  /** Response headers of the main document, lower-cased. */
  headers?: Record<string, string>
}

export interface Block {
  /** Who blocked, for the model and the user. */
  reason: string
  /** A check that may pass by itself after a few seconds, such as Cloudflare's "Just a moment". */
  pending: boolean
}

/** How long a challenge that might pass by itself is given before handing over. */
const SETTLE = 8000
const POLL = 500
/** A page shorter than this has room for little more than a block message. */
const SHORT = 1500
const BLOCKING_STATUS = new Set([401, 403, 429, 503])

/** Runs in the page. Only reads; never touches what the page shows. */
export const SCRIPT = `() => {
  const has = (selector) => {
    try {
      return document.querySelector(selector) !== null
    } catch {
      return false
    }
  }
  const markers = []
  if (window._cf_chl_opt || has("#challenge-form, #challenge-stage, #challenge-running, #cf-challenge-running"))
    markers.push("cloudflare-challenge")
  if (has("#cf-error-details, .cf-error-details")) markers.push("cloudflare-block")
  if (has('iframe[src*="captcha-delivery.com/interstitial"]')) markers.push("datadome-interstitial")
  else if (has('iframe[src*="captcha-delivery.com"]')) markers.push("datadome")
  if (has("#px-captcha")) markers.push("perimeterx")
  if (has('iframe[src*="_Incapsula_Resource"]')) markers.push("imperva")
  if (/(^|\\.)google\\.[a-z.]+$/.test(location.hostname) && location.pathname.startsWith("/sorry/")) markers.push("google-sorry")
  if (window.gokuProps) markers.push(has("#captcha-container") ? "aws-waf-captcha" : "aws-waf")
  if (has('iframe[src*="challenges.cloudflare.com"], .cf-turnstile')) markers.push("turnstile")
  if (has('iframe[src*="hcaptcha.com"], .h-captcha')) markers.push("hcaptcha")
  if (has('iframe[src*="/recaptcha/"], .g-recaptcha')) markers.push("recaptcha")
  const text = ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim()
  return {
    url: location.href,
    title: document.title || "",
    text: text.slice(0, 800),
    length: text.length,
    markers,
    ready: document.readyState,
  }
}`

/** Fingerprints that settle it on their own. */
const VENDORS: Record<string, Block> = {
  "cloudflare-challenge": { reason: "Cloudflare challenge", pending: true },
  "cloudflare-block": { reason: "Cloudflare block", pending: false },
  "datadome-interstitial": { reason: "DataDome check", pending: true },
  datadome: { reason: "DataDome captcha", pending: false },
  perimeterx: { reason: "PerimeterX (HUMAN) captcha", pending: false },
  imperva: { reason: "Imperva (Incapsula) block", pending: false },
  "google-sorry": { reason: "Google unusual traffic captcha", pending: false },
  "aws-waf": { reason: "AWS WAF challenge", pending: true },
  "aws-waf-captcha": { reason: "AWS WAF captcha", pending: false },
}

/** Captchas that mean nothing alone: plenty of login forms carry one. */
const WIDGETS: Record<string, string> = {
  turnstile: "Cloudflare Turnstile captcha",
  hcaptcha: "hCaptcha",
  recaptcha: "reCAPTCHA",
}

interface Phrase {
  pattern: RegExp
  reason: string
  pending?: boolean
  /** Wording too common to trust without an error status. */
  strict?: boolean
}

const PHRASES: Phrase[] = [
  { pattern: /just a moment|^um momento/im, reason: "bot check", pending: true },
  { pattern: /checking (your browser|if the site connection is secure)/i, reason: "bot check", pending: true },
  { pattern: /verificando (seu navegador|se (você|voce) (é|e) humano)/i, reason: "bot check", pending: true },
  { pattern: /enable javascript and cookies to continue/i, reason: "bot check", pending: true },
  { pattern: /verify (that )?you are (a )?human|confirm you are (a )?human/i, reason: "human verification" },
  { pattern: /(verifique|confirme) (se|que) (você|voce) (é|e) (um )?humano/i, reason: "human verification" },
  { pattern: /are you a robot|(você|voce) (é|e) um rob(ô|o)/i, reason: "robot check" },
  { pattern: /unusual traffic|tr(á|a)fego incomum/i, reason: "unusual traffic block" },
  { pattern: /press (&|and) hold/i, reason: "press and hold captcha" },
  { pattern: /pardon our interruption/i, reason: "bot block" },
  { pattern: /you('ve| have) been blocked/i, reason: "bot block" },
  { pattern: /attention required/i, reason: "bot block" },
  { pattern: /access denied|acesso negado/i, reason: "access denied", strict: true },
  { pattern: /request (blocked|unsuccessful)/i, reason: "request blocked", strict: true },
]

/**
 * Decides whether a page is a block. Pure, so every rule can be tested without
 * a browser; `undefined` means the page is the site itself.
 */
export function classify(signals: Signals): Block | undefined {
  if (signals.headers?.["cf-mitigated"]?.toLowerCase() === "challenge") {
    return { reason: "Cloudflare challenge", pending: true }
  }
  for (const marker of signals.markers) {
    const vendor = VENDORS[marker]
    if (vendor) return vendor
  }

  const failed = signals.status !== undefined && BLOCKING_STATUS.has(signals.status)
  const short = signals.length < SHORT
  const words = `${signals.title}\n${signals.text}`
  const phrase = PHRASES.find((item) => item.pattern.test(words))
  if (phrase && (failed || (short && !phrase.strict))) {
    return { reason: phrase.reason, pending: phrase.pending === true }
  }

  const widget = signals.markers.find((marker) => WIDGETS[marker])
  if (widget && failed) return { reason: WIDGETS[widget], pending: false }
  return undefined
}

/** Whether a navigation error is a site slamming the door on a headless browser. */
export function refused(errorText: string): Block | undefined {
  // Akamai's usual answer to a browser it distrusts is to break the HTTP/2
  // stream, which Chromium reports as a protocol error rather than a page.
  if (errorText.includes("ERR_HTTP2_PROTOCOL_ERROR")) {
    return { reason: "connection refused (HTTP/2 stream reset, typical of Akamai)", pending: false }
  }
  return undefined
}

/**
 * The page the person actually wanted. Google's captcha carries it in
 * `continue`, and handing over the captcha itself would be useless.
 */
export function wanted(url: string) {
  try {
    const parsed = new URL(url)
    const captcha = /(^|\.)google\.[a-z.]+$/.test(parsed.hostname) && parsed.pathname.startsWith("/sorry/")
    const next = captcha ? parsed.searchParams.get("continue") : null
    if (next && /^https?:\/\//.test(next)) return next
  } catch {}
  return url
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function strip(url: string) {
  const index = url.indexOf("#")
  return index < 0 ? url : url.slice(0, index)
}

/** Reads the page, or nothing while it is between documents. */
async function read(tab: Tab): Promise<Signals | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const page = await Promise.race([
    tab.evaluate<Omit<Signals, "status" | "headers">>(`(${SCRIPT})()`).catch(() => undefined),
    // A page mid-navigation can leave an evaluation unanswered.
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 3000)
    }),
  ]).finally(() => clearTimeout(timer))
  if (!page) return undefined
  // The response is only this page's if nothing has navigated since.
  const document = tab.document
  if (document && strip(document.url) === strip(page.url)) {
    return { ...page, status: document.status, headers: document.headers }
  }
  return page
}

/**
 * Checks the current page. A challenge that may pass by itself gets up to
 * `settle` ms to do so; if it does, this waits for the page it leads to and
 * judges that one instead.
 */
export async function check(tab: Tab, settle = SETTLE): Promise<Block | undefined> {
  const deadline = Date.now() + settle
  let signals = await read(tab)
  let block = signals && classify(signals)
  if (!block?.pending) return block

  while (Date.now() < deadline) {
    await sleep(POLL)
    const next = await read(tab)
    // Between documents, or still parsing one, there is nothing to judge yet.
    if (!next || next.ready === "loading") continue
    signals = next
    block = classify(next)
    if (!block?.pending) break
  }
  if (block) return block

  // Passed. The page it led to gets to finish loading, and is judged too,
  // since a site can put a wall of its own behind the vendor's.
  const until = Date.now() + 5000
  while (signals?.ready !== "complete" && Date.now() < until) {
    await sleep(200)
    signals = await read(tab)
  }
  return signals && classify(signals)
}

export * as BrowserBlocked from "./blocked"
