import { randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { Tab } from "./tab"

/**
 * Reading PDFs the agent runs into while browsing.
 *
 * A browser shows a PDF in a viewer of its own that has no DOM worth reading:
 * the outline of such a page is empty. Driving the person's own browser it is
 * worse, since the browser throws the extension's debugger off a tab the
 * moment its PDF viewer takes over. So a PDF is not read in the page: its
 * bytes are fetched, directly or from inside a page of the same site with the
 * person's session, and its text is extracted here.
 *
 * The file is also kept, in the person's Downloads folder, and shown in the
 * browser by a viewer this server serves: an ordinary page the agent can
 * drive, screenshot and scroll, so figures and scanned pages, which have no
 * text to extract, can still be looked at.
 */

/** Larger files are not worth reading page by page in a conversation. */
const MAX_BYTES = 30 * 1024 * 1024
/** About 15 thousand tokens; a longer text is cut at a page boundary. */
const MAX_CHARS = 60_000
const FETCH_TIMEOUT = 30_000

export class PdfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PdfError"
  }
}

/** Whether a URL, or a response's content type, says PDF. */
export function looksLikePdf(url: string, contentType?: string) {
  if (contentType && /application\/(x-)?pdf/i.test(contentType)) return true
  try {
    return /\.pdf$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function isPdf(bytes: Uint8Array) {
  // "%PDF-", allowing for a little junk in front, which readers tolerate.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1")
  return head.includes("%PDF-")
}

/** Runs in the page: fetches with the page's own cookies and returns the bytes as base64. */
const PAGE_FETCH = `async (input) => {
  const response = await fetch(input.url, { credentials: "include" })
  if (!response.ok) throw new Error("HTTP " + response.status)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > input.max) throw new Error("the file is larger than " + input.max + " bytes")
  const bytes = new Uint8Array(buffer)
  let text = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000))
  }
  return btoa(text)
}`

async function direct(url: string, accept: (bytes: Uint8Array) => boolean, what: string) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { accept: "application/pdf,*/*;q=0.8" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!response.ok) throw new PdfError(`HTTP ${response.status}`)
  const length = Number(response.headers.get("content-length") ?? 0)
  if (length > MAX_BYTES) throw new PdfError(`the file is larger than ${MAX_BYTES} bytes`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  // A site that wants a login answers with its sign-in page, not an error.
  if (!accept(bytes)) throw new PdfError(`the site answered with something other than ${what}`)
  return bytes
}

async function inPage(url: string, tab: Tab, accept: (bytes: Uint8Array) => boolean, what: string) {
  const encoded = await tab.evaluate<string>(`(${PAGE_FETCH})(${JSON.stringify({ url, max: MAX_BYTES })})`)
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"))
  if (!accept(bytes)) throw new PdfError(`the site answered with something other than ${what}`)
  return bytes
}

/**
 * Downloads a PDF, or with `accept` another kind of file. Straight from the
 * server first, which works for public files and never disturbs a page;
 * failing that, from inside `tab`, so a file behind the person's login comes
 * with their session.
 */
export async function download(url: string, tab?: Tab, accept = isPdf, what = "a PDF") {
  const failures: string[] = []
  try {
    return await direct(url, accept, what)
  } catch (error) {
    failures.push(`direct: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (tab?.connected) {
    try {
      return await inPage(url, tab, accept, what)
    } catch (error) {
      failures.push(`with the page's session: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new PdfError(`Could not download ${what} at ${url} (${failures.join("; ")}).`)
}

/** The text of each page. */
export async function text(bytes: Uint8Array) {
  // Loaded on first use: it is large, and most sessions never meet a PDF.
  const { extractText, getDocumentProxy } = await import("unpdf")
  // A copy: pdf.js takes over the buffer it is given, leaving the caller's empty.
  const document = await getDocumentProxy(new Uint8Array(bytes))
  try {
    const result = await extractText(document, { mergePages: false })
    return { totalPages: result.totalPages, pages: result.text.map((page) => page.replace(/[ \t]+\n/g, "\n").trim()) }
  } finally {
    await document.loadingTask.destroy().catch(() => {})
  }
}

/** What the model is given: the text page by page, cut at a page boundary when long. */
export function render(input: { url: string; pages: string[]; totalPages: number }) {
  const lines = [`url: ${input.url}`, `type: PDF, ${input.totalPages} page${input.totalPages === 1 ? "" : "s"}`]
  const body: string[] = []
  let size = 0
  let shown = 0
  for (const [index, page] of input.pages.entries()) {
    const block = `--- page ${index + 1} ---\n${page || "(no text on this page; it may be an image)"}`
    if (shown > 0 && size + block.length > MAX_CHARS) break
    body.push(block)
    size += block.length
    shown++
  }
  if (shown < input.pages.length) lines.push(`note: text cut after page ${shown} of ${input.totalPages} to keep it short`)
  if (input.pages.every((page) => !page)) {
    lines.push("note: no text could be extracted; the PDF is probably scanned images")
  }
  return [...lines, "", ...body].join("\n")
}

/** Downloads a PDF and renders its text for the model. */
export async function read(url: string, tab?: Tab) {
  const bytes = await download(url, tab)
  return render({ url, ...(await text(bytes)) })
}

/**
 * Downloads a PDF, keeps it in the Downloads folder and reads it: what the
 * agent is given when it meets one while browsing. `viewer` is where the
 * browser can show it, when this process runs a server to show it from.
 */
export async function open(url: string, tab?: Tab, name?: string) {
  const bytes = await download(url, tab)
  const [file, content] = await Promise.all([save(url, bytes, undefined, name), text(bytes)])
  const base = await serverUrl()
  return {
    file,
    pages: content.totalPages,
    text: render({ url, ...content }),
    viewer: base ? new URL(`${VIEWER}${publish(file, url)}`, base).href : undefined,
  }
}

/**
 * Writes the file to the Downloads folder under the name in its address. The
 * same PDF met again is not saved twice; another one with the same name gets
 * a number, as browsers do.
 */
export async function save(
  url: string,
  bytes: Uint8Array,
  dir = path.join(Global.Path.home, "Downloads"),
  suggested?: string,
) {
  await fs.mkdir(dir, { recursive: true })
  const name = suggested ? fileName(`file:///${encodeURIComponent(suggested)}`, path.extname(suggested)) : fileName(url)
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let copy = 1; copy < 100; copy++) {
    const file = path.join(dir, copy === 1 ? name : `${stem} (${copy})${ext}`)
    const existing = await fs.readFile(file).catch(() => undefined)
    if (existing && Buffer.compare(existing, bytes) === 0) return file
    if (existing) continue
    await fs.writeFile(file, bytes)
    return file
  }
  throw new PdfError(`Could not find a free name for ${name} in ${dir}.`)
}

/** A safe file name from the last part of an address, with `ext` added when it lacks it. */
export function fileName(url: string, ext = ".pdf") {
  const last = URL.canParse(url) ? new URL(url).pathname.split("/").pop() ?? "" : ""
  const clean = safeDecode(last)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120)
  if (!clean) return `documento${ext}`
  return clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean : `${clean}${ext}`
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Files the viewer may serve, by an id nobody can guess: the viewer is opened
 * by a browser that carries none of this server's credentials, so the id is
 * what grants it one file and nothing else.
 */
const shelf = new Map<string, { file: string; url: string }>()
const VIEWER = "/experimental/browser/pdf/"

function publish(file: string, url: string) {
  const known = [...shelf].find((entry) => entry[1].file === file)
  if (known) return known[0]
  const id = randomUUID().replaceAll("-", "")
  shelf.set(id, { file, url })
  return id
}

/** The file behind a viewer id, if it was published. */
export function shelved(id: string) {
  return shelf.get(id)?.file
}

/** The PDF a viewer page shows, when `url` is one. */
export function viewed(url: string) {
  if (!URL.canParse(url)) return undefined
  const pathname = new URL(url).pathname
  if (!pathname.startsWith(VIEWER)) return undefined
  return shelf.get(pathname.slice(VIEWER.length).split("/")[0])
}

/** The text of the PDF a viewer page shows, read again from the kept file. */
export async function readViewed(url: string) {
  const shown = viewed(url)
  if (!shown) return undefined
  const bytes = new Uint8Array(await fs.readFile(shown.file))
  return [render({ url: shown.url, ...(await text(bytes)) }), `saved at: ${shown.file}`].join("\n")
}

async function serverUrl() {
  const { Server } = await import("@/server/server")
  if (!Server.url) return undefined
  const base = new URL(Server.url)
  // A server listening on every interface is reached here on this machine.
  if (base.hostname === "0.0.0.0" || base.hostname === "[::]") base.hostname = "127.0.0.1"
  return base
}

/** pdf.js from a CDN: the desktop build ships no copy a browser could load. */
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build"
/** Beyond this many pages the viewer stops drawing; the file is still there to open. */
const VIEWER_PAGES = 150

/**
 * The page showing a published PDF: each page drawn on a canvas under a
 * heading, so the outline says where each page is and a screenshot shows it.
 * `documentElement.dataset.ready` is set once every page is drawn.
 */
export function viewerPage(id: string) {
  const shown = shelf.get(id)
  if (!shown) return undefined
  const name = escape(path.basename(shown.file))
  const href = `${VIEWER}${id}/file`
  const config = JSON.stringify({ file: href, pdfjs: PDFJS, max: VIEWER_PAGES })
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  body { margin: 0; background: #3b3d40; color: #e8eaed; font: 14px/1.4 system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 1; display: flex; gap: 16px; align-items: center; padding: 10px 16px; background: #202124; box-shadow: 0 1px 4px #0008; }
  header h1 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header a { color: #8ab4f8; }
  main { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 16px; }
  section { width: 100%; max-width: 900px; }
  section h2 { margin: 0 0 6px; font-size: 12px; font-weight: 500; color: #bdc1c6; }
  canvas { display: block; width: 100%; height: auto; background: #fff; box-shadow: 0 1px 6px #0009; }
  .error { max-width: 600px; padding: 24px; background: #202124; border-radius: 8px; }
</style>
</head>
<body>
<header><h1>${name}</h1><span id="status" role="status">Carregando…</span><a href="${href}" download="${name}">Baixar</a></header>
<main id="pages"></main>
<script type="module">
const config = ${config}
const status = document.getElementById("status")
const pages = document.getElementById("pages")
const done = (text) => {
  status.textContent = text
  document.documentElement.dataset.ready = "1"
}
try {
  const pdfjs = await import(config.pdfjs + "/pdf.min.mjs")
  pdfjs.GlobalWorkerOptions.workerSrc = config.pdfjs + "/pdf.worker.min.mjs"
  const doc = await pdfjs.getDocument({ url: config.file }).promise
  const total = doc.numPages
  const shown = Math.min(total, config.max)
  for (let number = 1; number <= shown; number++) {
    status.textContent = "Página " + number + " de " + total
    const page = await doc.getPage(number)
    const width = Math.min(900, document.documentElement.clientWidth - 32)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: (width / base.width) * Math.min(window.devicePixelRatio || 1, 2) })
    const section = document.createElement("section")
    section.id = "pagina-" + number
    const heading = document.createElement("h2")
    heading.textContent = "Página " + number + " de " + total
    const canvas = document.createElement("canvas")
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    canvas.setAttribute("role", "img")
    canvas.setAttribute("aria-label", "Página " + number)
    section.append(heading, canvas)
    pages.append(section)
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise
  }
  done(shown < total ? "Mostrando " + shown + " de " + total + " páginas" : total + (total === 1 ? " página" : " páginas"))
} catch (error) {
  const box = document.createElement("div")
  box.className = "error"
  box.textContent = "Não foi possível mostrar o PDF aqui (" + String((error && error.message) || error) + "). Use o link Baixar."
  pages.replaceChildren(box)
  done("Erro")
}
</script>
</body>
</html>`
}

function escape(value: string) {
  return value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
}

export * as BrowserPdf from "./pdf"
