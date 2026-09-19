import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { BrowserBlocked, type Signals } from "../../src/browser/blocked"
import { BrowserInstall } from "../../src/browser/install"
import { Tab } from "../../src/browser/tab"

/** A page as the detector sees it; long and error free unless a test says otherwise. */
function page(input: Partial<Signals>): Signals {
  return { url: "https://example.com/", title: "", text: "", length: 5000, markers: [], ...input }
}

const classify = BrowserBlocked.classify

describe("block detection", () => {
  test("Cloudflare's challenge header settles it on its own", () => {
    expect(classify(page({ headers: { "cf-mitigated": "challenge" } }))).toEqual({
      reason: "Cloudflare challenge",
      pending: true,
    })
  })

  test("anti-bot vendors are recognised by their own fingerprints", () => {
    expect(classify(page({ markers: ["cloudflare-challenge"] }))).toEqual({
      reason: "Cloudflare challenge",
      pending: true,
    })
    expect(classify(page({ markers: ["datadome"] }))?.reason).toContain("DataDome")
    expect(classify(page({ markers: ["perimeterx"] }))?.reason).toContain("PerimeterX")
    const sorry = classify(
      page({ url: "https://www.google.com/sorry/index?continue=x", markers: ["google-sorry"], status: 429 }),
    )
    expect(sorry?.reason).toContain("Google")
    // A captcha never passes by itself, so there is nothing to wait for.
    expect(sorry?.pending).toBe(false)
  })

  test("block wording counts on an error status", () => {
    const akamai = page({
      title: "Access Denied",
      text: 'Access Denied You don\'t have permission to access "http://www.example.com/" on this server. Reference #18.5f2',
      length: 110,
      status: 403,
    })
    expect(classify(akamai)).toEqual({ reason: "access denied", pending: false })
  })

  test("bot check wording counts on a page too short to be the site", () => {
    const block = classify(page({ title: "Just a moment...", text: "Checking your browser", length: 60 }))
    expect(block).toEqual({ reason: "bot check", pending: true })
    expect(classify(page({ title: "Verifique se você é humano", length: 80 }))?.pending).toBe(false)
  })

  test("a login form with a captcha is still the site", () => {
    const login = page({
      title: "Sign in",
      text: "Sign in to your account. Verify you are human below. " + "Terms and conditions. ".repeat(100),
      length: 2300,
      markers: ["recaptcha"],
      status: 200,
    })
    expect(classify(login)).toBeUndefined()
    // Short, but a successful page with nothing but the widget to go on.
    expect(classify(page({ title: "Sign in", length: 300, markers: ["recaptcha"], status: 200 }))).toBeUndefined()
  })

  test("an article about being denied access is not a block", () => {
    expect(classify(page({ title: "Access denied: a history of paywalls", length: 9000, status: 200 }))).toBeUndefined()
    // Generic wording on a short page needs an error status to count.
    expect(classify(page({ title: "Access denied", length: 200, status: 200 }))).toBeUndefined()
  })

  test("an error status alone is not a block", () => {
    expect(classify(page({ title: "403 Forbidden", text: "nginx", length: 20, status: 403 }))).toBeUndefined()
  })

  test("a captcha widget on an error page is", () => {
    expect(classify(page({ title: "Security check", length: 3000, markers: ["hcaptcha"], status: 403 }))).toEqual({
      reason: "hCaptcha",
      pending: false,
    })
  })

  test("a broken HTTP/2 stream is a refusal, other network errors are not", () => {
    expect(BrowserBlocked.refused("Could not open https://x: net::ERR_HTTP2_PROTOCOL_ERROR")).toBeDefined()
    expect(BrowserBlocked.refused("Could not open https://x: net::ERR_NAME_NOT_RESOLVED")).toBeUndefined()
  })

  test("Google's captcha hands over the search it interrupted", () => {
    const sorry = "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dgatos&q=EgQ"
    expect(BrowserBlocked.wanted(sorry)).toBe("https://www.google.com/search?q=gatos")
    const other = "https://example.com/sorry/x?continue=https://elsewhere.example"
    expect(BrowserBlocked.wanted(other)).toBe(other)
  })
})

const CHALLENGE = (script = "") => `<!doctype html>
<html>
  <head><title>Just a moment...</title></head>
  <body>
    <p>Verify you are human by completing the action below.</p>
    <p>127.0.0.1 needs to review the security of your connection before proceeding.</p>
    ${script}
  </body>
</html>`

const NORMAL = `<!doctype html>
<html>
  <head><title>Normal page</title></head>
  <body><h1>Welcome</h1><p>${"Real content. ".repeat(200)}</p></body>
</html>`

const target = BrowserInstall.installed() ?? BrowserInstall.downloaded()
const describeBrowser = target ? describe : describe.skip

/**
 * The detector in a real browser, against a local server that answers the way
 * Cloudflare does. What only a browser can tell: that the top-level response
 * is captured and iframes' are not, and that a challenge which passes by
 * itself is waited out rather than handed over.
 */
describeBrowser("block detection in a real browser", () => {
  let server: ReturnType<typeof Bun.serve>
  let base: string
  let child: ChildProcess
  let tab: Tab

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
          new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } })
        const { pathname } = new URL(request.url)
        if (pathname === "/challenge") return html(CHALLENGE(), 403, { "cf-mitigated": "challenge" })
        if (pathname === "/clears") {
          const script = `<script>setTimeout(() => location.replace("/normal"), 1000)</script>`
          return html(CHALLENGE(script), 403, { "cf-mitigated": "challenge" })
        }
        if (pathname === "/framed") return html(`<title>Framed</title>${NORMAL}<iframe src="/challenge"></iframe>`)
        if (pathname === "/press") {
          return html(`<title>Access to this page has been denied</title><div id="px-captcha"></div>`, 403)
        }
        return html(NORMAL)
      },
    })
    base = `http://127.0.0.1:${server.port}`

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-blocked-"))
    child = spawn(
      target!.executablePath!,
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--edge-skip-compat-layer-relaunch",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    )
    child.unref()

    const portFile = path.join(profile, "DevToolsActivePort")
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
    tab = await Tab.attach("tab_1", page.id, page.webSocketDebuggerUrl)
  }, 60_000)

  afterAll(() => {
    tab?.close()
    child?.kill()
    server?.stop(true)
  })

  test("a challenge that never passes is reported once the wait runs out", async () => {
    await tab.navigate(`${base}/challenge`, "load", 20_000)
    expect(tab.document).toMatchObject({ url: `${base}/challenge`, status: 403 })
    expect(tab.document?.headers["cf-mitigated"]).toBe("challenge")

    const started = Date.now()
    expect(await BrowserBlocked.check(tab, 1500)).toEqual({ reason: "Cloudflare challenge", pending: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400)
  }, 30_000)

  test("a challenge that passes by itself is waited out, not handed over", async () => {
    await tab.navigate(`${base}/clears`, "load", 20_000)
    expect(await BrowserBlocked.check(tab, 8000)).toBeUndefined()
    expect(await tab.url()).toBe(`${base}/normal`)
    expect(await tab.title()).toBe("Normal page")
  }, 30_000)

  test("a normal page is let through at once", async () => {
    await tab.navigate(`${base}/normal`, "load", 20_000)
    expect(tab.document).toMatchObject({ url: `${base}/normal`, status: 200 })
    const started = Date.now()
    expect(await BrowserBlocked.check(tab)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  }, 30_000)

  test("an iframe's response is not taken for the page's", async () => {
    await tab.navigate(`${base}/framed`, "load", 20_000)
    expect(tab.document).toMatchObject({ url: `${base}/framed`, status: 200 })
    expect(await BrowserBlocked.check(tab, 1500)).toBeUndefined()
  }, 30_000)

  test("a vendor's captcha is found in the page itself", async () => {
    await tab.navigate(`${base}/press`, "load", 20_000)
    const block = await BrowserBlocked.check(tab, 1500)
    expect(block?.reason).toContain("PerimeterX")
    expect(block?.pending).toBe(false)
  }, 30_000)
})
