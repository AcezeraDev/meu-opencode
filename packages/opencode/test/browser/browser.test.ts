import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CDPConnection } from "../../src/browser/cdp"
import { BrowserInstall } from "../../src/browser/install"
import { BrowserSnapshot } from "../../src/browser/snapshot"
import { Tab } from "../../src/browser/tab"

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
    <div hidden><button id="hidden-button">Invisible</button></div>
    <script>
      document.getElementById("go").addEventListener("click", () => {
        document.getElementById("status").textContent = "sent:" + document.getElementById("email").value
        console.log("clicked send")
      })
    </script>
  </body>
</html>`

const target = BrowserInstall.installed() ?? BrowserInstall.downloaded()

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

  test("screenshots come back as real PNG bytes", async () => {
    const buffer = await tab.screenshot()
    expect(buffer.byteLength).toBeGreaterThan(1000)
    // PNG magic number.
    expect(buffer.subarray(0, 4).toString("hex")).toBe("89504e47")
  })
})
