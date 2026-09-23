import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CDPConnection } from "../../src/browser/cdp"
import { BrowserInstall } from "../../src/browser/install"
import { BrowserPage } from "../../src/browser/page"
import { BrowserPdf } from "../../src/browser/pdf"
import { BrowserSnapshot, type SnapshotResult } from "../../src/browser/snapshot"
import { Tab } from "../../src/browser/tab"
import { makePdf } from "../fixture/pdf"

const PAGE = `<!doctype html>
<html>
  <head><title>Test Page</title></head>
  <body>
    <h1>Hello</h1>
    <nav><a href="https://example.com/docs">Docs</a></nav>
    <form id="form">
      <label for="email">Email</label>
      <input id="email" type="text" placeholder="you@example.com" />
      <input id="agree" type="checkbox" />
      <select id="plan">
        <option value="free">Free</option>
        <option value="pro">Pro</option>
      </select>
      <button type="button" id="go">Send</button>
    </form>
    <p id="status">idle</p>
    <a id="next" href="page2.html">Next page</a>
    <div hidden><button id="hidden-button">Invisible</button></div>
    <script>
      document.getElementById("go").addEventListener("click", () => {
        document.getElementById("status").textContent = "sent:" + document.getElementById("email").value
        console.log("clicked send")
      })
    </script>
  </body>
</html>`

/** A page of a course site: the same long menu on every page, and its own body. */
const COURSE = (page: string) => `<!doctype html>
<html>
  <head><title>Course page ${page}</title></head>
  <body>
    <nav aria-label="Course index">
      ${Array.from({ length: 12 }, (_, index) => `<a href="/course/${index + 1}">Lesson ${index + 1}</a>`).join("\n      ")}
    </nav>
    <main><h1>Lesson ${page}</h1><p>Page ${page} body</p><button id="mutate">Mutate</button></main>
  </body>
</html>`

const PAGE2 = `<!doctype html>
<html>
  <head><title>Second Page</title></head>
  <body><h1>Second</h1><button type="button">Again</button></body>
</html>`

/**
 * An activity the way H5P builds one: a frame whose document is written by
 * script, holding another frame written the same way, with the question in it.
 */
const QUIZ = `<!doctype html>
<html>
  <head><title>Quiz</title></head>
  <body>
    <h1>Pause e Responda</h1>
    <iframe id="outer" style="width: 600px; height: 400px; margin-top: 40px; border: 4px solid #ccc"></iframe>
    <script>
      const outer = document.getElementById("outer").contentDocument
      outer.open()
      outer.write('<body style="margin: 20px"><p>Atividade</p><iframe id="inner" style="width: 500px; height: 300px"></iframe></body>')
      outer.close()
      const inner = outer.getElementById("inner").contentDocument
      inner.open()
      inner.write('<body><p>Qual e o risco?</p><ul><li role="radio" aria-checked="false" tabindex="0" id="wrong">Diminuir variaveis</li><li role="radio" aria-checked="false" tabindex="0" id="right">Criar uma ordem artificial</li></ul><input id="note" placeholder="Comentario"><button id="verify">Verificar</button><p id="result"></p></body>')
      inner.close()
      for (const option of inner.querySelectorAll("[role=radio]")) {
        option.addEventListener("click", () => {
          for (const other of inner.querySelectorAll("[role=radio]")) other.setAttribute("aria-checked", "false")
          option.setAttribute("aria-checked", "true")
        })
      }
      inner.getElementById("verify").addEventListener("click", () => {
        const right = inner.getElementById("right").getAttribute("aria-checked") === "true"
        inner.getElementById("result").textContent = (right ? "Correto: " : "Errado: ") + inner.getElementById("note").value
      })
    </script>
  </body>
</html>`

/** A quiz inside a display: contents island, with answers clickable only by script, and an ad. */
const ISLAND = `<!doctype html>
<html>
  <head><title>Island</title></head>
  <body>
    <astro-island style="display: contents">
      <div id="card">
        <h2>Qual animal nao pertence ao grupo?</h2>
        <div id="lion" style="cursor: pointer"><span>Leao</span></div>
        <div id="zebra">Zebra</div>
        <p id="picked">nenhum</p>
      </div>
    </astro-island>
    <iframe title="Publicidade" srcdoc="<a href='https://ads.example/'>Compre agora</a>"></iframe>
    <script>
      document.getElementById("lion").addEventListener("click", () => (document.getElementById("picked").textContent = "leao"))
      document.getElementById("zebra").onclick = () => (document.getElementById("picked").textContent = "zebra")
    </script>
  </body>
</html>`

/** A button fully under a modal, and one only partly under a banner. */
const COVERED = `<!doctype html>
<html>
  <head><title>Covered</title></head>
  <body style="margin: 0">
    <button id="partly" style="position: fixed; top: 100px; left: 20px; width: 200px; height: 100px" onclick="document.title = 'partly'">Parcial</button>
    <div style="position: fixed; top: 100px; left: 0; width: 400px; height: 60px; background: #333"></div>
    <button id="hidden" style="position: fixed; top: 300px; left: 20px; width: 200px; height: 40px">Enviar</button>
    <div id="modal" style="position: fixed; top: 280px; left: 0; width: 400px; height: 100px; background: #0008"><button id="close">Fechar</button></div>
  </body>
</html>`

/** A button that asks before doing anything. */
const DIALOG = `<!doctype html>
<html>
  <head><title>Dialog</title></head>
  <body><button id="ask" onclick="if (confirm('Tem certeza?')) document.title = 'confirmado'">Enviar</button></body>
</html>`

const PDF = makePdf(["Material da aula", "Formas normais"])

/** Serves the quiz, a public PDF, and one that needs the cookie /login sets. */
const web = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const url = new URL(request.url)
    const html = (body: string, headers: Record<string, string> = {}) =>
      new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } })
    if (url.pathname === "/quiz") return html(QUIZ)
    if (url.pathname.startsWith("/course/")) return html(COURSE(url.pathname.slice("/course/".length)))
    if (url.pathname === "/island") return html(ISLAND)
    if (url.pathname === "/covered") return html(COVERED)
    if (url.pathname === "/dialog") return html(DIALOG)
    if (url.pathname === "/doc.pdf") return new Response(PDF, { headers: { "content-type": "application/pdf" } })
    if (url.pathname === "/login") return html("<title>Logged in</title>ok", { "set-cookie": "session=1; Path=/" })
    if (url.pathname === "/private.pdf") {
      if (request.headers.get("cookie")?.includes("session=1")) {
        return new Response(PDF, { headers: { "content-type": "application/pdf" } })
      }
      return html("<title>Entrar</title><form>login</form>")
    }
    return html(`<title>Aula</title><a id="material" href="/doc.pdf">Material da Aula</a>`)
  },
})
const webUrl = `http://127.0.0.1:${web.port}`
afterAll(() => web.stop(true))

const target = BrowserInstall.installed() ?? BrowserInstall.downloaded()

/**
 * The message a call fails with. Bun's `expect(call()).rejects` can sit on the
 * promise without letting the browser's reply in, until the call times out, so
 * failures of calls that talk to the browser are awaited here instead.
 */
async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
}

function outline(url: string, lines: string[]): SnapshotResult {
  return { url, title: "T", outline: lines.join("\n"), refs: 0, lastRef: 0, truncated: false }
}

/**
 * These exercise a real browser over CDP, which is the part that cannot be
 * verified any other way. Without a Chromium-based browser installed there is
 * nothing meaningful to assert, so the suite steps aside.
 */
const describeBrowser = target ? describe : describe.skip

describe("browser install", () => {
  test("reports whether a browser can be launched", () => {
    expect(typeof BrowserInstall.available()).toBe("boolean")
  })

  test("an explicit executable path wins over detection", () => {
    const resolved = BrowserInstall.resolve({ executablePath: "/custom/browser" })
    expect(resolved.executablePath).toBe("/custom/browser")
  })

  test("a ref becomes an attribute selector", () => {
    expect(BrowserSnapshot.locator("ref_7")).toBe('[data-oc-ref="ref_7"]')
    expect(BrowserSnapshot.locator("7")).toBe('[data-oc-ref="ref_7"]')
  })
})

describe("what an action changed", () => {
  // Pages are long; a change is a few lines of them.
  const filler = Array.from({ length: 40 }, (_, index) => `- text: Paragraph ${index} of the lesson`)
  const quiz = (yes: boolean, extra: string[] = []) => [
    '- heading "Quiz" [level=1]',
    `- radio "Yes" [ref_1 checked=${yes}]`,
    '- radio "No" [ref_2 checked=false]',
    '- button "Check" [ref_3]',
    ...extra,
    ...filler,
  ]
  const before = outline("https://a.test/quiz", quiz(false))

  test("without an earlier outline, or on another page, the whole outline comes back", () => {
    expect(BrowserPage.renderChange(undefined, before)).toContain('button "Check"')
    const elsewhere = outline("https://a.test/other", ['- button "Other" [ref_9]'])
    expect(BrowserPage.renderChange(before, elsewhere)).toBe(BrowserPage.render(elsewhere))
  })

  test("says so when nothing changed", () => {
    expect(BrowserPage.renderChange(before, outline("https://a.test/quiz#top", before.outline.split("\n")))).toContain(
      "No visible change",
    )
  })

  test("a small change comes back as a diff of just those lines", () => {
    const after = outline("https://a.test/quiz", quiz(true, ["- text: Correct!"]))
    const text = BrowserPage.renderChange(before, after)
    expect(text).toContain('-- radio "Yes" [ref_1 checked=false]')
    expect(text).toContain('+- radio "Yes" [ref_1 checked=true]')
    expect(text).toContain("+- text: Correct!")
    expect(text).not.toContain("Paragraph 30")
  })

  test("a page that changed almost completely comes back whole", () => {
    const after = outline("https://a.test/quiz", ['- heading "Results"', "- text: 1 of 1", '- link "Home" [ref_7]'])
    expect(BrowserPage.renderChange(before, after)).toBe(BrowserPage.render(after))
  })
})

describeBrowser("browser over CDP", () => {
  let child: ChildProcess
  let connection: CDPConnection
  let tab: Tab
  let profile: string
  let pageUrl: string

  beforeAll(async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-test-"))
    const file = path.join(profile, "page.html")
    fs.writeFileSync(file, PAGE)
    fs.writeFileSync(path.join(profile, "page2.html"), PAGE2)
    pageUrl = `file://${file.replace(/\\/g, "/")}`

    child = spawn(
      target!.executablePath!,
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${path.join(profile, "profile")}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
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

    const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as any
    connection = new CDPConnection(version.webSocketDebuggerUrl)
    await connection.connect()

    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as any[]
    const page = targets.find((item) => item.type === "page")
    tab = await Tab.attach("tab_1", page.id, page.webSocketDebuggerUrl)
    await tab.navigate(pageUrl, "load", 20_000)
  }, 60_000)

  afterAll(() => {
    // Nothing here may block: the browser is killed outright and the temp
    // profile is left for the OS, which is what it is there for.
    tab?.close()
    connection?.close()
    child?.kill()
  })

  test("reads the page after scripts have run", async () => {
    expect(await tab.title()).toBe("Test Page")
    const text = await tab.text()
    expect(text.text).toContain("Hello")
  })

  test("blocked hosts are never fetched, and the rest of the page still loads", async () => {
    const hits: string[] = []
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        hits.push(`${url.hostname}${url.pathname}`)
        if (url.pathname === "/page")
          return new Response(
            `<!doctype html><title>Ads</title><img src="http://localhost:${url.port}/ad.png"><img src="http://127.0.0.1:${url.port}/photo.png">`,
            { headers: { "content-type": "text/html" } },
          )
        return new Response("", { headers: { "content-type": "image/png" } })
      },
    })
    await tab.block([`localhost:${server.port}`])
    try {
      await tab.navigate(`http://127.0.0.1:${server.port}/page`, "load", 20_000)
      expect(hits).toContain("127.0.0.1/photo.png")
      expect(hits).not.toContain("localhost/ad.png")
      expect(tab.network.find((entry) => entry.url.includes("/ad.png"))?.failure).toBeDefined()
    } finally {
      await tab.block([])
      await tab.navigate(pageUrl, "load", 20_000)
    }
  })

  test("the outline gives every actionable element a ref", async () => {
    const snapshot = await tab.snapshot()
    expect(snapshot.refs).toBeGreaterThan(0)
    expect(snapshot.outline).toContain('link "Docs"')
    expect(snapshot.outline).toContain('button "Send"')
    expect(snapshot.outline).toContain("ref_")
    // The email input is named by its label, not its placeholder.
    expect(snapshot.outline).toContain('textbox "Email"')
  })

  test("hidden elements stay out of the outline", async () => {
    const snapshot = await tab.snapshot()
    expect(snapshot.outline).not.toContain("Invisible")
  })

  test("filling and clicking drives the page like a person", async () => {
    await tab.fill("#email", "someone@example.com")
    await tab.click("#go")
    expect(await tab.evaluate<string>("document.getElementById('status').textContent")).toBe("sent:someone@example.com")
  })

  test("acting through a ref from the outline works", async () => {
    await tab.navigate(pageUrl, "load", 20_000)
    const snapshot = await tab.snapshot()
    const line = snapshot.outline.split("\n").find((item) => item.includes('button "Send"'))!
    const ref = /ref_\d+/.exec(line)![0]
    await tab.fill("#email", "ref@example.com")
    await tab.click(BrowserSnapshot.locator(ref))
    expect(await tab.evaluate<string>("document.getElementById('status').textContent")).toBe("sent:ref@example.com")
  })

  test("checkboxes and selects are set, not just clicked", async () => {
    await tab.setChecked("#agree", true)
    expect(await tab.evaluate<boolean>("document.getElementById('agree').checked")).toBe(true)
    await tab.setChecked("#agree", false)
    expect(await tab.evaluate<boolean>("document.getElementById('agree').checked")).toBe(false)

    await tab.select("#plan", "Pro")
    expect(await tab.evaluate<string>("document.getElementById('plan').value")).toBe("pro")
  })

  test("console output is captured for debugging", async () => {
    await tab.click("#go")
    expect(tab.console.some((entry) => entry.text.includes("clicked send"))).toBe(true)
  })

  test("waiting for an element that is already there returns at once", async () => {
    await tab.waitFor({ selector: "#go" }, 5_000)
  })

  test("waiting for something absent fails with a useful message", async () => {
    await expect(tab.waitFor({ selector: "#nope" }, 600)).rejects.toThrow(/did not become visible/)
  })

  test("acting on a stale ref explains how to recover", async () => {
    await expect(tab.click(BrowserSnapshot.locator("ref_999"))).rejects.toThrow(/fresh browser_snapshot/)
  })

  test("screenshots come back as real JPEG bytes", async () => {
    const buffer = await tab.screenshot()
    expect(buffer.byteLength).toBeGreaterThan(1000)
    // JPEG magic number.
    expect(buffer.subarray(0, 3).toString("hex")).toBe("ffd8ff")
  })

  test("refs stay put across snapshots, and a new page continues the numbering", async () => {
    await tab.navigate(pageUrl, "load", 20_000)
    const refOf = (snapshot: SnapshotResult, name: string) =>
      /ref_\d+/.exec(snapshot.outline.split("\n").find((line) => line.includes(name))!)![0]

    const first = await tab.snapshot()
    const second = await tab.snapshot()
    expect(refOf(second, 'button "Send"')).toBe(refOf(first, 'button "Send"'))
    expect(second.lastRef).toBe(first.lastRef)

    // A ref from a page that is gone must not land on the new page's elements.
    await tab.navigate(pageUrl, "load", 20_000)
    const fresh = await tab.snapshot()
    const number = (ref: string) => Number(ref.slice(4))
    expect(number(refOf(fresh, 'button "Send"'))).toBeGreaterThan(first.lastRef)
    expect(await failure(tab.click(BrowserSnapshot.locator(refOf(first, 'button "Send"'))))).toMatch(
      /fresh browser_snapshot/,
    )
  })

  test("an action that only changes the page settles at once, without waiting for a load", async () => {
    await tab.navigate(pageUrl, "load", 20_000)
    const mark = tab.mark()
    const start = Date.now()
    await tab.fill("#email", "fast@example.com")
    await tab.click("#go")
    await tab.settle(mark, 20_000)
    expect(Date.now() - start).toBeLessThan(1400)
    expect(await tab.evaluate<string>("document.getElementById('status').textContent")).toBe("sent:fast@example.com")
  })

  test("an action that opens a page waits for it", async () => {
    await tab.navigate(pageUrl, "load", 20_000)
    await BrowserPage.perform(tab, { action: "click", selector: "#next" }, 20_000)
    expect(await tab.title()).toBe("Second Page")
  })

  test("a step without a target, or with a ref that is gone, fails with a reason", async () => {
    expect(await failure(BrowserPage.perform(tab, { action: "click" }, 5_000))).toMatch(/needs a ref or a selector/)
    expect(await failure(BrowserPage.perform(tab, { action: "click", ref: "ref_99999" }, 5_000))).toMatch(
      /fresh browser_snapshot/,
    )
  })

  test("frames of the same site are part of the outline, and acting inside them works", async () => {
    await tab.navigate(`${webUrl}/quiz`, "load", 20_000)
    const snapshot = await tab.snapshot()
    const refOf = (name: string) =>
      /ref_\d+/.exec(snapshot.outline.split("\n").find((line) => line.includes(name))!)![0]
    expect(snapshot.outline).toContain('radio "Criar uma ordem artificial"')
    expect(snapshot.outline).toContain('button "Verificar"')

    // Clicks land on the element inside the frames, at the right place.
    await BrowserPage.perform(tab, { action: "click", ref: refOf("Criar uma ordem artificial") }, 10_000)
    await BrowserPage.perform(tab, { action: "fill", ref: refOf("Comentario"), text: "ordem falsa" }, 10_000)
    await BrowserPage.perform(tab, { action: "click", ref: refOf('button "Verificar"') }, 10_000)
    const after = await tab.snapshot()
    expect(after.outline).toContain('radio "Criar uma ordem artificial" [' + refOf("Criar uma ordem artificial"))
    expect(after.outline).toContain("checked=true")
    expect(after.outline).toContain("Correto: ordem falsa")
    expect((await tab.text()).text).toContain("Correto: ordem falsa")
  })

  test("a click that opens a PDF is known to have, and its text can be read", async () => {
    await tab.navigate(webUrl, "load", 20_000)
    expect(tab.pdf).toBeUndefined()
    await BrowserPage.perform(tab, { action: "click", selector: "#material" }, 20_000)
    expect(tab.pdf).toBe(`${webUrl}/doc.pdf`)
    const text = await BrowserPage.readPdf(tab.pdf!, tab)
    expect(text).toContain("type: PDF, 2 pages")
    expect(text).toContain("Formas normais")
  })

  test("sees inside display: contents wrappers, and divs clicked by script, but not ads", async () => {
    await tab.navigate(`${webUrl}/island`, "load", 20_000)
    const snapshot = await tab.snapshot()
    expect(snapshot.outline).toContain('heading "Qual animal nao pertence ao grupo?"')
    expect(snapshot.outline).toContain('clickable "Leao"')
    expect(snapshot.outline).toContain('clickable "Zebra"')
    // Text that only repeats the clickable's name is not listed again.
    expect(snapshot.outline).not.toContain("text: Leao")
    expect(snapshot.outline).not.toContain("Compre agora")
    const zebra = /ref_\d+/.exec(snapshot.outline.split("\n").find((line) => line.includes('clickable "Zebra"'))!)![0]
    await BrowserPage.perform(tab, { action: "click", ref: zebra }, 10_000)
    expect(await tab.evaluate<string>("document.getElementById('picked').textContent")).toBe("zebra")
  })

  test("clicks the part of an element that is not covered, and says what covers it when nothing is free", async () => {
    await tab.navigate(`${webUrl}/covered`, "load", 20_000)
    // The banner covers the middle of this button, but not its lower part.
    await tab.click("#partly")
    expect(await tab.title()).toBe("partly")
    expect(await failure(tab.click("#hidden"))).toMatch(/covered by/)
  })

  test("answers the page's dialogs so the tab never hangs, and says what they said", async () => {
    await tab.navigate(`${webUrl}/dialog`, "load", 20_000)
    const start = Date.now()
    await BrowserPage.perform(tab, { action: "click", selector: "#ask" }, 10_000)
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(await tab.title()).toBe("confirmado")
    const text = BrowserPage.outline(tab, await tab.snapshot())
    expect(text).toContain('confirm dialog saying "Tem certeza?"')
    // Told once.
    expect(BrowserPage.outline(tab, await tab.snapshot())).not.toContain("confirm dialog")
  })

  test("a screenshot comes with the text it shows, frames included", async () => {
    await tab.navigate(`${webUrl}/quiz`, "load", 20_000)
    const text = await tab.visibleText()
    expect(text).toContain("Pause e Responda")
    expect(text).toContain("Criar uma ordem artificial")
  })

  test("a PDF behind a login is read with the page's session", async () => {
    await tab.navigate(`${webUrl}/login`, "load", 20_000)
    // Straight from the server, without the cookie, the site answers with its login page.
    expect(await failure(BrowserPdf.download(`${webUrl}/private.pdf`))).toContain("something other than a PDF")
    const text = await BrowserPdf.read(`${webUrl}/private.pdf`, tab)
    expect(text).toContain("Material da aula")
  })

  const DND = `<!doctype html><html><body>
    <div style="cursor:default"><div id="w" style="cursor:grab">Banana</div></div>
    <div id="zone" class="dropzone" style="min-height:30px;padding:8px">Solte aqui</div>
    <div id="sq" style="width:40px;height:40px;background:rgb(22,163,74);cursor:pointer"></div>
    <div id="dbl" ondblclick="void 0" style="padding:4px">dobre</div>
    <input id="d" type="date">
    <input id="r" type="range" min="0" max="100" value="10">
  </body></html>`

  test("drag words, drop zones, coloured squares and double-click boxes get refs", async () => {
    await tab.navigate(`data:text/html,${encodeURIComponent(DND)}`, "load", 20_000)
    const outline = (await tab.snapshot()).outline
    expect(outline).toContain('draggable "Banana"')
    expect(outline).toContain('dropzone "Solte aqui"')
    expect(outline).toMatch(/clickable \[ref_\d+ color=verde\]/)
    expect(outline).toContain("dblclick")
  })

  test("a date field takes dd/mm/yyyy and a range takes a number", async () => {
    await tab.navigate(`data:text/html,${encodeURIComponent(DND)}`, "load", 20_000)
    await tab.fill("#d", "15/03/2008")
    expect(await tab.evaluate<string>("document.getElementById('d').value")).toBe("2008-03-15")
    await tab.fill("#r", "75")
    expect(await tab.evaluate<string>("document.getElementById('r').value")).toBe("75")
  })

  test("actions on one tab run one at a time, not interleaved", async () => {
    const order: string[] = []
    const slow = tab.serialize(async () => {
      order.push("a-start")
      await new Promise((resolve) => setTimeout(resolve, 60))
      order.push("a-end")
    })
    const quick = tab.serialize(async () => {
      order.push("b-start")
      order.push("b-end")
    })
    await Promise.all([slow, quick])
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"])
  })

  test("wait_for a ref that is gone fails fast, not after the full timeout", async () => {
    await tab.navigate(`data:text/html,${encodeURIComponent(DND)}`, "load", 20_000)
    const started = Date.now()
    const message = await failure(tab.waitFor({ selector: '[data-oc-ref="ref_99999"]' }, 30_000))
    expect(message).toContain("not on the page")
    expect(Date.now() - started).toBeLessThan(6_000)
  })

  test("a new page of the same site leaves out the menu it repeats, and the old refs still reach it", async () => {
    await tab.navigate(`${webUrl}/course/1`, "load", 20_000)
    const first = await tab.snapshot()
    expect(BrowserPage.landed(tab, first).output).toContain('link "Lesson 12"')
    const line = first.outline.split("\n").find((item) => item.includes('link "Lesson 3"'))!
    const ref = /ref_\d+/.exec(line)![0]

    await tab.navigate(`${webUrl}/course/2`, "load", 20_000)
    const arrived = BrowserPage.landed(tab, await tab.snapshot())
    const text = arrived.output
    expect(arrived.partial).toBe(true)
    expect(text).toContain("more lines as in the last full outline")
    expect(text).toContain("Page 2 body")
    expect(text).not.toContain('link "Lesson 12"')

    await tab.click(BrowserSnapshot.locator(ref))
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (await tab.title()) !== "Course page 3")
      await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await tab.title()).toBe("Course page 3")
  })

  test("the same page again is shown whole", async () => {
    await tab.navigate(`${webUrl}/course/4`, "load", 20_000)
    BrowserPage.landed(tab, await tab.snapshot())
    await tab.reload("load", 20_000)
    expect(BrowserPage.landed(tab, await tab.snapshot()).output).toContain('link "Lesson 12"')
  })

  test("a page whose timers are held back is waited out from this side", async () => {
    await tab.navigate(`${webUrl}/course/5`, "load", 20_000)
    // Changes the page every 50 ms for 400 ms, driven by the page's own clock.
    await tab.evaluate(
      `(() => { const end = performance.now() + 400; const tick = () => { document.title = String(Math.random()); if (performance.now() < end) setTimeout(tick, 50) }; tick() })()`,
    )
    tab["throttled"] = true
    const started = Date.now()
    await tab.quiet()
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(300)
    expect(waited).toBeLessThan(1_500)
    // The page answered that it is on screen, so its own clock is trusted again.
    expect(tab["throttled"]).toBe(false)
  })
})
