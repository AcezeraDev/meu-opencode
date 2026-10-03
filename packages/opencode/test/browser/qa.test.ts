import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { BrowserInstall } from "../../src/browser/install"
import { BrowserQA } from "../../src/browser/qa"
import { Tab } from "../../src/browser/tab"

const target = BrowserInstall.installed() ?? BrowserInstall.downloaded()
const describeBrowser = target ? describe : describe.skip

/**
 * A small site with problems planted on purpose: a JavaScript error, a broken
 * image, grey-on-white text, a banner wider than a phone, a page without <h1>,
 * and a logout link that must never be visited.
 */
const HOME = `<!doctype html><html><head><title>Loja</title><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;font-family:sans-serif">
<h1>Loja</h1>
<p style="color:#bbb;background:#fff">Frete grátis acima de R$ 100</p>
<div class="banner" style="width:600px;height:40px;background:#036;color:#fff">Promoção da semana</div>
<img src="/nao-existe.png" alt="produto">
<a href="/sobre">Sobre</a> <a href="/sair">Sair</a>
<script>setTimeout(() => { undefined.preco }, 10)</script>
</body></html>`
const ABOUT = `<!doctype html><html><head><title>Sobre</title><meta name="viewport" content="width=device-width"></head>
<body><p style="color:#111">Somos uma loja.</p><button style="width:20px;height:20px">x</button></body></html>`

describeBrowser("site check", () => {
  let child: ChildProcess
  let tab: Tab
  let profile: string
  let server: ReturnType<typeof Bun.serve>
  const visited: string[] = []

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        visited.push(url.pathname)
        if (url.pathname === "/") return new Response(HOME, { headers: { "content-type": "text/html" } })
        if (url.pathname === "/sobre") return new Response(ABOUT, { headers: { "content-type": "text/html" } })
        return new Response("not found", { status: 404 })
      },
    })
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-qa-test-"))
    child = spawn(
      target!.executablePath!,
      ["--remote-debugging-port=0", `--user-data-dir=${path.join(profile, "profile")}`, "--headless=new", "--no-first-run", "about:blank"],
      { stdio: "ignore", windowsHide: true },
    )
    child.unref()
    const portFile = path.join(profile, "profile", "DevToolsActivePort")
    let port: string | undefined
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !port) {
      try {
        port = fs.readFileSync(portFile, "utf8").split("\n")[0]?.trim()
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (!port) throw new Error("browser did not start")
    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as any[]
    const page = targets.find((item) => item.type === "page")
    tab = await Tab.attach("tab_qa", page.id, page.webSocketDebuggerUrl)
  }, 60_000)

  afterAll(() => {
    tab?.close()
    child?.kill()
    server?.stop(true)
  })

  test("finds the planted problems, page by page and size by size, and keeps the screenshots", async () => {
    const base = `http://127.0.0.1:${server.port}/`
    const report = await BrowserQA.run({ tab, url: base, navigate: (url) => tab.navigate(url, "load", 20_000).then(() => {}) })
    const kinds = (page: string, viewport?: string) =>
      report.issues.filter((issue) => issue.page.endsWith(page) && (!viewport || issue.viewport === viewport)).map((issue) => issue.kind)

    expect(report.pages).toEqual([base, `${base}sobre`])
    expect(visited).not.toContain("/sair")
    expect(report.shots).toHaveLength(6)
    expect(report.shots.every((shot) => fs.statSync(shot.file).size > 1000)).toBe(true)

    expect(kinds("/")).toContain("javascript")
    expect(kinds("/")).toContain("image")
    expect(kinds("/")).toContain("network")
    expect(kinds("/")).toContain("contrast")
    // 600px fits a desktop and a tablet, not a 390px phone.
    expect(kinds("/", "mobile")).toContain("overflow")
    expect(kinds("/", "desktop")).not.toContain("overflow")
    const overflow = report.issues.find((issue) => issue.kind === "overflow")!
    expect(overflow.message).toContain("banner")
    expect(kinds("/sobre", "desktop")).toContain("structure")
    expect(kinds("/sobre", "mobile")).toContain("tap-target")
    // The same script error on three sizes is reported once.
    expect(report.issues.filter((issue) => issue.kind === "javascript")).toHaveLength(1)

    const contrast = report.issues.find((issue) => issue.kind === "contrast")!
    expect(contrast.message).toMatch(/Contraste 1\.\d+:1 \(mínimo 4\.5:1\)/)

    // The window is back to its own size.
    const width = await tab.evaluate<number>("window.innerWidth")
    expect(width).not.toBe(390)

    // A second check of the same site points at the first one: before and after.
    const again = await BrowserQA.run({ tab, url: base, crawl: 0, viewports: ["desktop"], navigate: (url) => tab.navigate(url, "load", 20_000).then(() => {}) })
    expect(again.previous?.id).toBe(report.id)
    expect(BrowserQA.render(again)).toContain(`Antes (checagem ${report.id})`)
  }, 120_000)

  test("which pages get visited", () => {
    const pages = BrowserQA.pickPages(
      "http://localhost:3000/",
      ["http://localhost:3000/a#top", "http://localhost:3000/logout", "https://outro.com/", "http://localhost:3000/b.pdf", "http://localhost:3000/c"],
      ["/painel"],
      2,
    )
    expect(pages).toEqual(["http://localhost:3000/", "http://localhost:3000/painel", "http://localhost:3000/a", "http://localhost:3000/c"])
  })
})
