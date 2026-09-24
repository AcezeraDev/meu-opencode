import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { BrowserPdf } from "@/browser/pdf"
import { Server } from "@/server/server"
import { makePdf } from "../fixture/pdf"
import { tmpdir } from "../fixture/fixture"

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

  test("keeps the file under the name in its address, without saving the same one twice", async () => {
    await using dir = await tmpdir()
    const url = `${base}/aulas/Aula%201%3A%20normaliza%C3%A7%C3%A3o.pdf?forcedownload=1`
    const first = await BrowserPdf.save(url, pdf, dir.path)
    expect(path.basename(first)).toBe("Aula 1_ normalização.pdf")
    expect(await BrowserPdf.save(url, pdf, dir.path)).toBe(first)
    // Another file with the same name is numbered, as browsers do.
    const other = await BrowserPdf.save(url, makePdf(["Outra"]), dir.path)
    expect(path.basename(other)).toBe("Aula 1_ normalização (2).pdf")
    expect(path.basename(await BrowserPdf.save(`${base}/mod/resource/view.php`, pdf, dir.path))).toBe("view.php.pdf")
    expect(path.basename(await BrowserPdf.save("https://a.test/", pdf, dir.path))).toBe("documento.pdf")
  })

  test("is shown by the server to a browser without its credentials, by an id only", async () => {
    const password = Flag.OPENCODE_SERVER_PASSWORD
    Flag.OPENCODE_SERVER_PASSWORD = "pdf-secret"
    process.env.OPENCODE_SERVER_PASSWORD = "pdf-secret"
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const opened = await BrowserPdf.open(`${base}/doc.pdf`)
      expect(opened.pages).toBe(2)
      expect(opened.text).toContain("Segunda pagina")
      expect(await fs.readFile(opened.file)).toEqual(Buffer.from(pdf))
      expect(opened.viewer?.startsWith(listener.url.origin)).toBe(true)

      const page = await fetch(opened.viewer!)
      expect(page.status).toBe(200)
      expect(page.headers.get("content-type")).toContain("text/html")
      expect(await page.text()).toContain("<title>doc.pdf</title>")
      const file = await fetch(`${opened.viewer}/file`)
      expect(file.headers.get("content-type")).toBe("application/pdf")
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf)

      expect((await fetch(new URL("/experimental/browser/pdf/nothing", listener.url))).status).toBe(404)
      expect((await fetch(new URL("/experimental/browser/pdf/nothing/file", listener.url))).status).toBe(404)
      // Everything else still asks for the password.
      expect((await fetch(new URL("/session", listener.url))).status).toBe(401)

      // A later read of the viewer's page gets the file's text back.
      const again = await BrowserPdf.readViewed(opened.viewer!)
      expect(again).toContain(`url: ${base}/doc.pdf`)
      expect(again).toContain("Primeira pagina")
      expect(await BrowserPdf.readViewed(`${base}/doc.pdf`)).toBeUndefined()
    } finally {
      await listener.stop(true)
      Flag.OPENCODE_SERVER_PASSWORD = password
      delete process.env.OPENCODE_SERVER_PASSWORD
    }
  })
})
