import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { Tab } from "./tab"

/**
 * Checks a site the agent built or changed, in the browser the person watches:
 * every page at desktop, tablet and phone sizes, with the JavaScript errors,
 * console errors and failed requests each one produced, measured layout
 * problems (horizontal overflow and what causes it, broken images, low
 * contrast, small tap targets) and a screenshot. Reports are kept, so the next
 * check of the same site says what changed: before and after.
 */

export const VIEWPORTS = {
  desktop: { width: 1366, height: 800, mobile: false },
  tablet: { width: 768, height: 1024, mobile: true },
  mobile: { width: 390, height: 844, mobile: true },
} as const
export type Viewport = keyof typeof VIEWPORTS

export interface Issue {
  severity: "error" | "warning"
  kind: string
  page: string
  viewport?: Viewport
  message: string
}

export interface Shot {
  page: string
  viewport: Viewport
  file: string
}

export interface Report {
  id: string
  url: string
  origin: string
  time: number
  pages: string[]
  viewports: Viewport[]
  issues: Issue[]
  shots: Shot[]
  /** The previous check of the same site, for before/after. */
  previous?: { id: string; time: number; errors: number; warnings: number }
}

export const root = () => path.join(Global.Path.data, "site-checks")

/** Measured inside the page: returns what the browser itself knows about the layout. */
// `width` is the device width: on a phone size Chrome shrinks a too-wide page
// to fit, so innerWidth grows with the overflow and would hide it.
const MEASURE = `((width) => {
  const vw = width || window.innerWidth
  const visible = (el) => {
    const s = getComputedStyle(el)
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const describe = (el) => {
    const id = el.id ? "#" + el.id : ""
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""
    const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || "").trim().replace(/\\s+/g, " ").slice(0, 40)
    return el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : "")
  }
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX
      if (o === "hidden" || o === "auto" || o === "scroll" || o === "clip") return true
    }
    return false
  }
  const all = Array.from(document.body ? document.body.querySelectorAll("*") : []).slice(0, 4000)
  const overflowing = all.filter((el) => {
    if (!visible(el) || clipped(el)) return false
    const r = el.getBoundingClientRect()
    return r.right > vw + 2 || r.left < -2
  })
  const outermost = overflowing.filter((el) => !overflowing.includes(el.parentElement)).slice(0, 5)
  const parse = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c)
    if (!m) return null
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const background = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.backgroundImage && s.backgroundImage !== "none") return null
      const c = parse(s.backgroundColor)
      if (c && c.a >= 0.9) return c
    }
    return { r: 255, g: 255, b: 255, a: 1 }
  }
  const contrast = []
  for (const el of all.slice(0, 1500)) {
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
    if (!own || !visible(el)) continue
    const s = getComputedStyle(el)
    const fg = parse(s.color)
    const bg = background(el)
    if (!fg || !bg || fg.a < 0.5) continue
    const a = lum(fg), b = lum(bg)
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    const size = parseFloat(s.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
    if (ratio < (large ? 3 : 4.5)) contrast.push({ el: describe(el), ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5 })
    if (contrast.length >= 40) break
  }
  contrast.sort((x, y) => x.ratio - y.ratio)
  const clickable = all.filter((el) => el.matches("a[href], button, input:not([type=hidden]), select, textarea, [role=button]") && visible(el))
  const small = clickable.filter((el) => { const r = el.getBoundingClientRect(); return r.width < 32 || r.height < 32 }).map(describe)
  const images = Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0 && img.src).map((img) => img.src).slice(0, 10)
  const links = Array.from(document.querySelectorAll("a[href]"))
    .map((a) => a.href)
    .filter((href) => { try { const u = new URL(href); return u.origin === location.origin } catch { return false } })
  return {
    title: document.title,
    h1: document.querySelectorAll("h1").length,
    text: (document.body && document.body.innerText || "").trim().length,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
    innerWidth: vw,
    overflow: outermost.map((el) => describe(el) + " vai até " + Math.round(el.getBoundingClientRect().right) + "px"),
    contrast: contrast.slice(0, 5),
    small: small.slice(0, 8),
    smallCount: small.length,
    images,
    links: Array.from(new Set(links)).slice(0, 60),
  }
})`

export interface Measure {
  title: string
  h1: number
  text: number
  scrollWidth: number
  innerWidth: number
  overflow: string[]
  contrast: { el: string; ratio: number; need: number }[]
  small: string[]
  smallCount: number
  images: string[]
  links: string[]
}

const NEVER = /logout|log-out|signout|sign-out|sair|excluir|delete|remove|apagar|\.(pdf|zip|png|jpe?g|svg|mp4)$/i

/** Pages worth visiting from the links of the first one: same site, no logout/delete, no files. */
export function pickPages(start: string, links: string[], extra: string[], crawl: number) {
  const origin = new URL(start).origin
  const clean = (href: string) => {
    const url = new URL(href, start)
    url.hash = ""
    return url.toString()
  }
  const chosen = [clean(start), ...extra.map((page) => clean(new URL(page, origin).toString()))]
  for (const link of links) {
    if (chosen.length >= 1 + extra.length + crawl) break
    const url = clean(link)
    if (new URL(url).origin !== origin || NEVER.test(url) || chosen.includes(url)) continue
    chosen.push(url)
  }
  return chosen
}

/** Issues from one page at one size: what the browser reported and what the measurements show. */
export function findings(input: {
  page: string
  viewport: Viewport
  status?: number
  console: { type: string; text: string }[]
  network: { url: string; status?: number; failure?: string }[]
  measure: Measure
}): Issue[] {
  const { page, viewport, measure } = input
  const at = { page, viewport }
  const issues: Issue[] = []
  if (input.status !== undefined && input.status >= 400)
    issues.push({ ...at, severity: "error", kind: "http", message: `A página respondeu HTTP ${input.status}` })
  for (const entry of input.console) {
    if (entry.type === "pageerror") issues.push({ ...at, severity: "error", kind: "javascript", message: `Erro de JavaScript: ${entry.text.slice(0, 300)}` })
    else if (entry.type === "error") issues.push({ ...at, severity: "error", kind: "console", message: `console.error: ${entry.text.slice(0, 300)}` })
  }
  for (const request of input.network) {
    // Browsers ask for it on their own; a project without one is not broken.
    if (/\/favicon\.ico(\?|$)/.test(request.url)) continue
    if (request.failure && !/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(request.failure))
      issues.push({ ...at, severity: "error", kind: "network", message: `Requisição falhou (${request.failure}): ${request.url.slice(0, 200)}` })
    else if (request.status !== undefined && request.status >= 400)
      issues.push({ ...at, severity: "error", kind: "network", message: `HTTP ${request.status}: ${request.url.slice(0, 200)}` })
  }
  if (measure.scrollWidth > measure.innerWidth + 2)
    issues.push({
      ...at,
      severity: "error",
      kind: "overflow",
      message: `Rolagem horizontal: a página tem ${measure.scrollWidth}px numa tela de ${measure.innerWidth}px${measure.overflow.length ? ". Passam da tela: " + measure.overflow.join("; ") : ""}`,
    })
  for (const src of measure.images) issues.push({ ...at, severity: "error", kind: "image", message: `Imagem quebrada: ${src.slice(0, 200)}` })
  for (const item of measure.contrast)
    issues.push({ ...at, severity: "warning", kind: "contrast", message: `Contraste ${item.ratio}:1 (mínimo ${item.need}:1) em ${item.el}` })
  if (viewport === "mobile" && measure.smallCount > 0)
    issues.push({
      ...at,
      severity: "warning",
      kind: "tap-target",
      message: `${measure.smallCount} elemento(s) clicável(is) menor(es) que 32px no celular, ex.: ${measure.small.slice(0, 3).join("; ")}`,
    })
  if (viewport === "desktop") {
    if (!measure.title.trim()) issues.push({ ...at, severity: "warning", kind: "seo", message: "A página não tem <title>" })
    if (measure.h1 === 0) issues.push({ ...at, severity: "warning", kind: "structure", message: "A página não tem <h1>" })
    if (measure.text < 20) issues.push({ ...at, severity: "warning", kind: "empty", message: "A página está quase sem texto (vazia ou ainda carregando?)" })
  }
  return issues
}

const slug = (url: string) =>
  (new URL(url).pathname.replace(/^\/|\/$/g, "").replace(/[^a-z0-9]+/gi, "-") || "inicio").slice(0, 60)

export async function previous(origin: string, before: number) {
  const dirs = await fs.readdir(root()).catch(() => [] as string[])
  const reports = await Promise.all(
    dirs.map((dir) =>
      fs
        .readFile(path.join(root(), dir, "report.json"), "utf8")
        .then((text) => JSON.parse(text) as Report)
        .catch(() => undefined),
    ),
  )
  return reports
    .filter((report): report is Report => report !== undefined && report.origin === origin && report.time < before)
    .sort((a, b) => b.time - a.time)[0]
}

export async function load(id: string) {
  if (!/^[a-z0-9-]+$/.test(id)) return undefined
  return fs
    .readFile(path.join(root(), id, "report.json"), "utf8")
    .then((text) => JSON.parse(text) as Report)
    .catch(() => undefined)
}

export async function latest(origin?: string) {
  const dirs = await fs.readdir(root()).catch(() => [] as string[])
  const reports = await Promise.all(dirs.map((dir) => load(dir)))
  return reports
    .filter((report): report is Report => report !== undefined && (!origin || report.origin === origin))
    .sort((a, b) => b.time - a.time)[0]
}

/**
 * Runs the check on `tab`. `navigate` loads a page the way the browser tools
 * do (same queue, same waits); the size is always set back afterwards.
 */
export async function run(input: {
  tab: Tab
  url: string
  extra?: string[]
  crawl?: number
  viewports?: Viewport[]
  navigate: (url: string) => Promise<void>
  onProgress?: (text: string) => void
}): Promise<Report> {
  const time = Date.now()
  const id = `${time.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const dir = path.join(root(), id)
  await fs.mkdir(dir, { recursive: true })
  const viewports = input.viewports?.length ? input.viewports : (Object.keys(VIEWPORTS) as Viewport[])
  const origin = new URL(input.url).origin
  const issues: Issue[] = []
  const shots: Shot[] = []
  let pages = [input.url]
  try {
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index]!
      for (const viewport of viewports) {
        input.onProgress?.(`${viewport} · ${page}`)
        await input.tab.emulate(VIEWPORTS[viewport])
        const since = Date.now()
        await input.navigate(page)
        await input.tab.quiet(300, 4000)
        const measure = await input.tab.evaluate<Measure>(`(${MEASURE})(${VIEWPORTS[viewport].width})`)
        const file = path.join(dir, `${slug(page)}-${viewport}.jpg`)
        await fs.writeFile(file, await input.tab.capture())
        shots.push({ page, viewport, file })
        issues.push(
          ...findings({
            page,
            viewport,
            status: input.tab.document?.status || undefined,
            console: input.tab.console.filter((entry) => entry.time >= since),
            network: input.tab.network.filter((entry) => entry.time >= since),
            measure,
          }),
        )
        if (index === 0 && viewport === viewports[0]) pages = pickPages(input.url, measure.links, input.extra ?? [], input.crawl ?? 4)
      }
    }
  } finally {
    await input.tab.clearResize()
  }
  // The same JavaScript error on every size is one problem, not three.
  const unique = issues.filter(
    (issue, index) =>
      issues.findIndex(
        (other) =>
          other.kind === issue.kind &&
          other.page === issue.page &&
          other.message === issue.message &&
          (issue.kind === "overflow" || issue.kind === "tap-target" ? other.viewport === issue.viewport : true),
      ) === index,
  )
  const before = await previous(origin, time)
  const report: Report = {
    id,
    url: input.url,
    origin,
    time,
    pages,
    viewports,
    issues: unique,
    shots,
    previous: before
      ? {
          id: before.id,
          time: before.time,
          errors: before.issues.filter((issue) => issue.severity === "error").length,
          warnings: before.issues.filter((issue) => issue.severity === "warning").length,
        }
      : undefined,
  }
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 1), "utf8")
  return report
}

/** The report as the model reads it: counts, then each problem with where it happens. */
export function render(report: Report) {
  const errors = report.issues.filter((issue) => issue.severity === "error")
  const warnings = report.issues.filter((issue) => issue.severity === "warning")
  const line = (issue: Issue) =>
    `- [${issue.kind}] ${issue.viewport ? `(${issue.viewport}) ` : ""}${new URL(issue.page).pathname}: ${issue.message}`
  return [
    `Checagem ${report.id} de ${report.origin}: ${report.pages.length} página(s) × ${report.viewports.join(", ")}.`,
    `${errors.length} erro(s), ${warnings.length} aviso(s).`,
    report.previous
      ? `Antes (checagem ${report.previous.id}): ${report.previous.errors} erro(s), ${report.previous.warnings} aviso(s).`
      : undefined,
    errors.length ? `\nErros:\n${errors.slice(0, 40).map(line).join("\n")}` : undefined,
    warnings.length ? `\nAvisos:\n${warnings.slice(0, 30).map(line).join("\n")}` : undefined,
    `\nPrints: ${report.shots.length} em ${path.dirname(report.shots[0]?.file ?? root())}.`,
    errors.length || warnings.length
      ? "Corrija o que for real, rode a checagem de novo e use visual_review para a avaliação visual."
      : "Nada encontrado pelas medições. Use visual_review para avaliar o visual pelos prints.",
  ]
    .filter((part) => part !== undefined)
    .join("\n")
}

export * as BrowserQA from "./qa"
