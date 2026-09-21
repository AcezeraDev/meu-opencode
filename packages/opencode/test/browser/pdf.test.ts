import { afterAll, describe, expect, test } from "bun:test"
import { BrowserPdf } from "@/browser/pdf"
import { makePdf } from "../fixture/pdf"

const pdf = makePdf(["Primeira pagina do material", "Segunda pagina sobre normalizacao"])

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const path = new URL(request.url).pathname
    if (path === "/doc.pdf") return new Response(pdf, { headers: { "content-type": "application/pdf" } })
    // What a site behind a login answers instead of the file.
    return new Response("<!doctype html><title>Entrar</title><form>login</form>", {
      headers: { "content-type": "text/html" },
    })
  },
})
const base = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

describe("reading PDFs", () => {
  test("tells PDFs apart by address or by content type", () => {
    expect(BrowserPdf.looksLikePdf("https://a.test/aulas/[SIS]S15A4ALUNO.pdf")).toBe(true)
    expect(BrowserPdf.looksLikePdf("https://a.test/file.PDF?download=1")).toBe(true)
    expect(BrowserPdf.looksLikePdf("https://a.test/mod/resource/view.php?id=1")).toBe(false)
    expect(BrowserPdf.looksLikePdf("https://a.test/view.php", "application/pdf")).toBe(true)
    expect(BrowserPdf.looksLikePdf("not a url")).toBe(false)
  })

  test("extracts the text of each page", async () => {
    const result = await BrowserPdf.text(pdf)
    expect(result.totalPages).toBe(2)
    expect(result.pages[0]).toContain("Primeira pagina do material")
    expect(result.pages[1]).toContain("Segunda pagina sobre normalizacao")
  })

  test("downloads and renders a public PDF page by page", async () => {
    const text = await BrowserPdf.read(`${base}/doc.pdf`)
    expect(text).toContain("type: PDF, 2 pages")
    expect(text).toContain("--- page 2 ---")
    expect(text).toContain("Segunda pagina")
  })

  test("a login page served instead of the file is a failure, not a PDF", async () => {
    const failure = await BrowserPdf.download(`${base}/private.pdf`).then(
      () => "",
      (error: Error) => error.message,
    )
    expect(failure).toContain("something other than a PDF")
  })

  test("a long text is cut at a page boundary, and a scanned PDF says so", () => {
    const long = BrowserPdf.render({ url: "u", totalPages: 3, pages: ["a".repeat(50_000), "b".repeat(50_000), "c"] })
    expect(long).toContain("--- page 1 ---")
    expect(long).not.toContain("--- page 2 ---")
    expect(long).toContain("text cut after page 1 of 3")

    const scanned = BrowserPdf.render({ url: "u", totalPages: 1, pages: [""] })
    expect(scanned).toContain("scanned images")
  })
})
