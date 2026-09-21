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

async function direct(url: string) {
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
  if (!isPdf(bytes)) throw new PdfError("the site answered with something other than a PDF")
  return bytes
}

async function inPage(url: string, tab: Tab) {
  const encoded = await tab.evaluate<string>(`(${PAGE_FETCH})(${JSON.stringify({ url, max: MAX_BYTES })})`)
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"))
  if (!isPdf(bytes)) throw new PdfError("the site answered with something other than a PDF")
  return bytes
}

/**
 * Downloads a PDF. Straight from the server first, which works for public
 * files and never disturbs a page; failing that, from inside `tab`, so a file
 * behind the person's login comes with their session.
 */
export async function download(url: string, tab?: Tab) {
  const failures: string[] = []
  try {
    return await direct(url)
  } catch (error) {
    failures.push(`direct: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (tab?.connected) {
    try {
      return await inPage(url, tab)
    } catch (error) {
      failures.push(`with the page's session: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new PdfError(`Could not download the PDF at ${url} (${failures.join("; ")}).`)
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

export * as BrowserPdf from "./pdf"
