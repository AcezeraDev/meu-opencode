import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { BrowserInstall } from "../../src/browser/install"
import { BrowserPage } from "../../src/browser/page"
import { BrowserCursor } from "../../src/browser/cursor"
import { BrowserSnapshot } from "../../src/browser/snapshot"
import { ActionVerifier, type Probe, type Verdict } from "../../src/browser/verify"
import { Tab, type Mark } from "../../src/browser/tab"
import { withStepOutline } from "../../src/tool/browser_batch"

/**
 * A page can move under an action between the moment the agent aims at an
 * element and the moment it presses: that gap is the cursor's glide, and on a
 * React page it is long enough for a re-render. These check what actually
 * reaches the page in that gap, which nothing but a real browser can answer.
 */

/** The element and a decoy in the very same place, so a stale coordinate is caught red-handed. */
const MOVING = `<!doctype html>
<html>
  <head><title>idle</title></head>
  <body style="margin: 0">
    <div id="decoy" style="position: fixed; left: 50px; top: 100px; width: 200px; height: 60px; background: #eee"
      onclick="document.title = 'decoy'">Decoy</div>
    <button id="mover" type="button" style="position: fixed; left: 50px; top: 100px; width: 200px; height: 60px"
      onclick="document.title = 'mover'">Mover</button>
    <script>
      // Changes the page at the one moment that matters: after the agent has
      // measured the element and before its click lands. Rather than racing a
      // timer against the cursor's travel, it waits for the cursor overlay to
      // be put into the page, which happens inside that very gap.
      window.whileTravelling = (what, cursorTag) => {
        // The agent puts its cursor back on a page it navigated to, so the
        // overlay is usually already here. Taking it away makes the next
        // action build it again, which is the moment being waited for; the
        // overlay rebuilds itself on demand, so nothing is lost by this.
        const stale = document.querySelector(cursorTag)
        if (stale) stale.remove()
        const observer = new MutationObserver(() => {
          if (!document.querySelector(cursorTag)) return
          observer.disconnect()
          const mover = document.getElementById("mover")
          if (what === "move") mover.style.top = "400px"
          else if (what === "remove") mover.remove()
          else if (what === "cover") {
            const cover = document.createElement("div")
            cover.id = "late"
            cover.textContent = "Aviso"
            cover.style.cssText =
              "position: fixed; left: 0; top: 80px; width: 400px; height: 120px; background: #333; z-index: 10"
            document.body.appendChild(cover)
          } else {
            // What a framework does when it re-renders: the same button, a new node.
            const fresh = mover.cloneNode(true)
            if (what === "recreate-bare" || what === "recreate-twins") fresh.removeAttribute("data-oc-ref")
            fresh.addEventListener("click", () => (document.title = "recreated"))
            if (what === "recreate-twins") {
              const twin = fresh.cloneNode(true)
              twin.addEventListener("click", () => (document.title = "wrong twin"))
              mover.replaceWith(fresh, twin)
            } else mover.replaceWith(fresh)
          }
        })
        observer.observe(document.documentElement, { childList: true })
      }
    </script>
  </body>
</html>`

/** A cover that goes away on its own, so a first attempt fails and a second can succeed. */
const TRANSIENT = `<!doctype html>
<html>
  <head><title>idle</title></head>
  <body style="margin: 0">
    <button id="target" type="button" style="position: fixed; left: 50px; top: 100px; width: 200px; height: 60px"
      onclick="document.title = 'clicked'">Enviar</button>
    <script>
      // Raised on demand, so the cover is certainly up when the action starts,
      // whatever the page took to load. While it is up it keeps the DOM
      // changing, the way a toast counting itself down would: the wait between
      // two attempts is a wait for the page to go still, so this makes the
      // second attempt land after the cover is gone rather than racing it.
      window.coverFor = (ms) => {
        const toast = document.createElement("div")
        toast.id = "toast"
        toast.textContent = "Aguarde"
        toast.style.cssText = "position: fixed; left: 0; top: 80px; width: 400px; height: 120px; background: #333; z-index: 10"
        document.body.appendChild(toast)
        const tick = setInterval(() => (toast.textContent = "Aguarde " + Date.now()), 30)
        setTimeout(() => {
          clearInterval(tick)
          toast.remove()
        }, ms)
      }
    </script>
  </body>
</html>`

/** A button at the bottom of a box that scrolls on its own, not with the page. */
const CONTAINER = `<!doctype html>
<html>
  <head><title>idle</title></head>
  <body style="margin: 0">
    <div id="box" style="height: 200px; width: 300px; overflow: auto; border: 1px solid #000">
      <div style="height: 900px"></div>
      <button id="deep" type="button" onclick="document.title = 'deep'">Fundo</button>
      <div style="height: 200px"></div>
    </div>
  </body>
</html>`

/**
 * A page that takes the wheel over from the browser, the way a smooth
 * scrolling library does: nothing is scrollable, and the content is moved with
 * a transform in answer to wheel events. A script `scrollBy` does nothing here.
 */
const HIJACK = `<!doctype html>
<html>
  <head><title>Hijack</title></head>
  <body style="margin: 0; overflow: hidden">
    <div id="stage" style="height: 400px; overflow: hidden">
      <div id="content" style="height: 3000px; transform: translateY(0px)">Conteudo</div>
    </div>
    <script>
      let offset = 0
      addEventListener(
        "wheel",
        (event) => {
          offset -= event.deltaY
          document.getElementById("content").style.transform = "translateY(" + offset + "px)"
        },
        { passive: true },
      )
    </script>
  </body>
</html>`

/**
 * Fields of the kind that ignore text handed to them: one that masks a phone
 * number from its key events, one that only trusts input it saw a key for (a
 * controlled input, as a framework builds it), and a search box whose
 * suggestions come from keystrokes.
 */
const TYPING = `<!doctype html>
<html>
  <head><title>Typing</title></head>
  <body>
    <input id="plain" placeholder="Nome" />
    <input id="phone" inputmode="tel" placeholder="Telefone" />
    <input id="picky" placeholder="Controlado" />
    <input id="search" placeholder="Busca" />
    <ul id="suggestions"></ul>
    <p id="keys">none</p>
    <script>
      const phone = document.getElementById("phone")
      phone.addEventListener("keydown", (event) => {
        if (event.key.length !== 1) return
        event.preventDefault()
        const digits = (phone.value + event.key).replace(/\\D/g, "").slice(0, 11)
        phone.value = digits.replace(/^(\\d{2})(\\d{0,5})(\\d{0,4}).*$/, (all, a, b, c) =>
          c ? "(" + a + ") " + b + "-" + c : b ? "(" + a + ") " + b : "(" + a,
        )
      })

      // A controlled input: anything it did not see a key for is thrown away.
      const picky = document.getElementById("picky")
      let sawKey = false
      picky.addEventListener("keydown", () => (sawKey = true))
      picky.addEventListener("input", () => {
        if (!sawKey) picky.value = ""
        sawKey = false
      })

      // An autocomplete that listens for keys, as many do.
      const search = document.getElementById("search")
      const suggestions = document.getElementById("suggestions")
      search.addEventListener("keyup", () => {
        suggestions.textContent = ""
        if (!search.value) return
        for (const item of ["Brasil", "Braganca", "Brasilia"]) {
          if (!item.toLowerCase().startsWith(search.value.toLowerCase())) continue
          const line = document.createElement("li")
          line.textContent = item
          suggestions.appendChild(line)
        }
      })

      // What the page actually receives for each key.
      document.addEventListener("keydown", (event) => {
        document.getElementById("keys").textContent =
          event.key + "|" + event.code + "|" + event.keyCode + "|" + (event.shiftKey ? "shift" : "plain")
      })
    </script>
  </body>
</html>`

/** Nothing here is taller than the window, so nothing can scroll. */
const SHORT = `<!doctype html>
<html>
  <head><title>Short</title></head>
  <body style="margin: 0"><p>Uma linha.</p></body>
</html>`

/**
 * Colour blocks far apart down the page, so a screenshot of one can be told
 * from a screenshot of the wrong strip by the colour alone.
 */
const STRIPES = `<!doctype html>
<html>
  <head><title>Stripes</title></head>
  <body style="margin: 0; background: #ffffff">
    <div id="near" style="width: 300px; height: 200px; background: rgb(0, 0, 255)"></div>
    <div style="height: 2600px"></div>
    <div id="far" style="width: 300px; height: 200px; background: rgb(255, 0, 0)"></div>
    <div style="height: 900px"></div>
  </body>
</html>`

/** A handle dragged with the mouse, a drop zone, a file input, and a button that reports held keys. */
const GESTURES = `<!doctype html>
<html>
  <head><title>Gestures</title></head>
  <body style="margin: 0">
    <button id="keys" type="button" style="position: fixed; left: 20px; top: 20px; width: 160px; height: 40px">
      Com teclas
    </button>
    <div id="handle" style="position: fixed; left: 20px; top: 100px; width: 120px; height: 60px; background: #8ab">
      Arraste
    </div>
    <div id="zone" style="position: fixed; left: 320px; top: 320px; width: 200px; height: 120px; background: #cdc">
      Solte aqui
    </div>
    <div id="native" draggable="true" style="position: fixed; left: 180px; top: 100px; width: 120px; height: 60px; background: #dab">
      Arquivo
    </div>
    <div id="native-zone" style="position: fixed; left: 560px; top: 320px; width: 200px; height: 120px; background: #adc">
      Destino nativo
    </div>
    <div id="reflow-handle" style="position: fixed; left: 20px; top: 210px; width: 120px; height: 60px; background: #acf">
      Reflua
    </div>
    <div id="reflow-zone" style="position: fixed; left: 320px; top: 210px; width: 160px; height: 70px; background: #cfa">
      Destino móvel
    </div>
    <div id="fallback" draggable="true" style="position: fixed; left: 180px; top: 210px; width: 120px; height: 60px; background: #fac">
      Mouse fallback
    </div>
    <div id="fallback-zone" style="position: fixed; left: 800px; top: 320px; width: 180px; height: 100px; background: #fca">
      Destino fallback
    </div>
    <input id="file" type="file" style="position: fixed; left: 20px; top: 500px" />
    <p id="result">none</p>
    <script>
      const result = document.getElementById("result")
      document.getElementById("keys").addEventListener("click", (event) => {
        result.textContent =
          "click:" + (event.ctrlKey ? "ctrl" : "") + (event.shiftKey ? "shift" : "") + (event.altKey ? "alt" : "")
      })

      // A box dragged with the mouse, the way a sortable list or a slider is.
      let dragging = false
      let moves = 0
      document.getElementById("handle").addEventListener("mousedown", () => {
        dragging = true
        moves = 0
      })
      document.addEventListener("mousemove", () => {
        if (dragging) moves++
      })
      document.getElementById("zone").addEventListener("mouseup", () => {
        if (!dragging) return
        dragging = false
        result.textContent = "dropped:" + moves
      })

      document.getElementById("native").addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", "native payload")
      })
      document.getElementById("native-zone").addEventListener("dragover", (event) => event.preventDefault())
      document.getElementById("native-zone").addEventListener("drop", (event) => {
        event.preventDefault()
        result.textContent = "native:" + event.dataTransfer.getData("text/plain")
      })

      let reflowing = false
      document.getElementById("reflow-handle").addEventListener("mousedown", () => {
        reflowing = true
        document.getElementById("reflow-zone").style.left = "600px"
      })
      document.getElementById("reflow-zone").addEventListener("mouseup", () => {
        if (reflowing) result.textContent = "reflowed"
        reflowing = false
      })

      let fallback = false
      document.getElementById("fallback").addEventListener("dragstart", (event) => event.preventDefault())
      document.getElementById("fallback").addEventListener("mousedown", () => (fallback = true))
      document.getElementById("fallback-zone").addEventListener("mouseup", () => {
        if (fallback) result.textContent = "mouse fallback"
        fallback = false
      })

      document.getElementById("file").addEventListener("change", (event) => {
        const file = event.target.files[0]
        result.textContent = "file:" + (file ? file.name : "none")
      })
    </script>
  </body>
</html>`

/** Open, nested and closed roots, plus a cover that leaves part of an internal button reachable. */
const SHADOW = `<!doctype html>
<html>
  <head>
    <title>Shadow</title>
    <style>open-box, outer-box, inner-box, closed-box { display: contents }</style>
  </head>
  <body style="margin: 0">
    <open-box></open-box>
    <outer-box></outer-box>
    <closed-box></closed-box>
    <div id="partial" style="position: fixed; left: 40px; top: 80px; width: 240px; height: 25px; z-index: 10; background: #333"></div>
    <script>
      const open = document.querySelector("open-box").attachShadow({ mode: "open" })
      open.innerHTML = '<button style="position: fixed; left: 40px; top: 80px; width: 240px; height: 100px">Open action</button>'
      open.querySelector("button").addEventListener("click", () => (document.title = "open clicked"))

      const outer = document.querySelector("outer-box").attachShadow({ mode: "open" })
      outer.innerHTML = '<style>inner-box { display: contents }</style><inner-box></inner-box>'
      const inner = outer.querySelector("inner-box").attachShadow({ mode: "open" })
      inner.innerHTML = '<button style="position: fixed; left: 360px; top: 100px; width: 200px; height: 80px">Nested action</button>'
      inner.querySelector("button").addEventListener("click", () => (document.title = "nested clicked"))

      const closed = document.querySelector("closed-box").attachShadow({ mode: "closed" })
      closed.innerHTML = '<button>Closed action</button>'
    </script>
  </body>
</html>`

/** A page that does nothing at all when clicked, and one link that leaves it. */
const QUIET_PAGE = `<!doctype html>
<html>
  <head><title>Quiet</title></head>
  <body>
    <button id="inert" type="button">Nada</button>
    <input id="box" type="checkbox" />
    <a id="away" href="stripes.html">Sair</a>
  </body>
</html>`

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
    switch (new URL(request.url).pathname) {
      case "/moving":
        return html(MOVING)
      case "/transient":
        return html(TRANSIENT)
      case "/container":
        return html(CONTAINER)
      case "/hijack":
        return html(HIJACK)
      case "/short":
        return html(SHORT)
      case "/typing":
        return html(TYPING)
      case "/gestures":
        return html(GESTURES)
      case "/shadow":
        return html(SHADOW)
      case "/stripes":
      case "/stripes.html":
        return html(STRIPES)
      default:
        return html(QUIET_PAGE)
    }
  },
})
const webUrl = `http://127.0.0.1:${server.port}`

/** An outline, line by line. */
const lines = (outline: string) => outline.split("\n")
afterAll(() => server.stop(true))

describe("verdicts", () => {
  const mark: Mark = { started: 0, stopped: 0, loaded: 0, complete: 0, request: 0 }
  const tab = { navigatedSince: () => false, dialogCount: 0 } as unknown as Parameters<
    typeof ActionVerifier.compare
  >[0]["tab"]
  const probe = (extra: Partial<Probe> = {}): Probe => ({
    url: "https://a.test/",
    present: true,
    active: "body",
    dialogs: 0,
    ...extra,
  })

  test("a state that changed is a confirmed action", () => {
    const verdict = ActionVerifier.compare({
      tab,
      mark,
      before: probe({ checked: false }),
      after: probe({ checked: true }),
      targeted: true,
    })
    expect(verdict.outcome).toBe("success_confirmed")
    expect(verdict.signals.join(" ")).toContain("checked")
  })

  test("an element that is gone is reported as such, not as a failure", () => {
    const verdict = ActionVerifier.compare({
      tab,
      mark,
      before: probe(),
      after: probe({ present: false }),
      targeted: true,
    })
    expect(verdict.outcome).toBe("target_changed")
  })

  test("nothing observable is its own outcome, which the outline can still settle", () => {
    const verdict = ActionVerifier.compare({ tab, mark, before: probe(), after: probe(), targeted: true })
    expect(verdict.outcome).toBe("success_no_visible_change")
    expect(ActionVerifier.withOutline(verdict, false).outcome).toBe("success_no_visible_change")
    expect(ActionVerifier.withOutline(verdict, true).outcome).toBe("success_confirmed")
  })

  test("a page that cannot be read afterwards is uncertain, never a success", () => {
    const verdict = ActionVerifier.compare({ tab, mark, before: probe(), after: undefined, targeted: true })
    expect(verdict.outcome).toBe("uncertain")
  })

  test("a value is compared without its text ever being read", () => {
    const verdict = ActionVerifier.compare({
      tab,
      mark,
      before: probe({ value: 1 }),
      after: probe({ value: 2 }),
      targeted: true,
    })
    expect(verdict.signals.join(" ")).toBe("the field's value changed")
    expect(JSON.stringify(verdict)).not.toContain("secret")
  })

  test("each outcome reads as a sentence the model can act on", () => {
    expect(
      ActionVerifier.render("click ref_1", { outcome: "navigation", signals: ["the page is now https://x/"] }),
    ).toContain("another page")
    expect(ActionVerifier.render("click ref_1", { outcome: "success_no_visible_change", signals: [] })).toContain(
      "nothing observable changed",
    )
    expect(
      ActionVerifier.render("click ref_1", {
        outcome: "success_confirmed",
        signals: ["it is now checked"],
        attempts: 2,
      }),
    ).toContain("attempt 2")
  })

  test("three batch steps each receive their own outline signal", () => {
    const snapshot = (outline: string) => ({
      url: "https://a.test/",
      title: "Batch",
      outline,
      refs: 0,
      lastRef: 0,
      truncated: false,
    })
    const base: Verdict = { outcome: "success_no_visible_change", signals: [] }
    const pages = [snapshot("one"), snapshot("two"), snapshot("three")]
    const verdicts = pages.map((page, index) =>
      withStepOutline(base, index === 0 ? snapshot("zero") : pages[index - 1], page),
    )
    expect(verdicts.map((verdict) => verdict.outcome)).toEqual([
      "success_confirmed",
      "success_confirmed",
      "success_confirmed",
    ])
    expect(verdicts.every((verdict) => verdict.signals.includes("the page outline changed"))).toBe(true)
  })
})

const target = BrowserInstall.installed() ?? BrowserInstall.downloaded()
const describeBrowser = target ? describe : describe.skip

describeBrowser("acting on a page that moves", () => {
  let child: ChildProcess
  let tab: Tab
  let profile: string

  /** The agent only glides towards an element while someone is watching, which is where the gap is. */
  const watched = { presenting: () => true, activity: () => {}, changed: () => {} }

  async function failure(promise: Promise<unknown>) {
    return promise.then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
  }

  /** Arms the page to change itself while the agent's cursor is on its way to the element. */
  function travelling(what: "move" | "remove" | "cover" | "recreate" | "recreate-bare" | "recreate-twins") {
    return tab.evaluate(`window.whileTravelling(${JSON.stringify(what)}, ${JSON.stringify(BrowserCursor.HOST_TAG)})`)
  }

  /** The colour in the middle of a JPEG, read by the browser itself so no decoder is needed here. */
  async function centre(buffer: Buffer) {
    return tab.evaluate<[number, number, number]>(
      `new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => {
          const canvas = document.createElement("canvas")
          canvas.width = image.width
          canvas.height = image.height
          const context = canvas.getContext("2d")
          context.drawImage(image, 0, 0)
          const pixel = context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data
          resolve([pixel[0], pixel[1], pixel[2]])
        }
        image.onerror = () => reject(new Error("could not decode"))
        image.src = "data:image/jpeg;base64,${buffer.toString("base64")}"
      })`,
    )
  }

  /** JPEG is lossy, so a solid block comes back near its colour rather than exactly on it. */
  function near(pixel: [number, number, number], expected: [number, number, number]) {
    return pixel.every((value, index) => Math.abs(value - expected[index]!) < 40)
  }

  beforeAll(async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-reliability-"))
    child = spawn(
      target!.executablePath!,
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${path.join(profile, "profile")}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,800",
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

    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as {
      type: string
      id: string
      webSocketDebuggerUrl: string
    }[]
    const page = targets.find((item) => item.type === "page")!
    tab = await Tab.attach("tab_1", page.id, page.webSocketDebuggerUrl, watched)
  }, 60_000)

  afterAll(() => {
    tab?.close()
    child?.kill()
  })

  test("an element that moves while the cursor travels is clicked where it ended up", async () => {
    await tab.navigate(`${webUrl}/moving`, "load", 20_000)
    await travelling("move")
    await tab.click("#mover")
    // The decoy is exactly where the button used to be: had the old coordinate
    // been used, it would have been clicked instead.
    expect(await tab.title()).toBe("mover")
  })

  test("an element that is removed while the cursor travels is not clicked at its old place", async () => {
    await tab.navigate(`${webUrl}/moving`, "load", 20_000)
    await travelling("remove")
    const message = await failure(tab.click("#mover"))
    expect(message).toMatch(/gone before the click could land/)
    expect(message).toMatch(/fresh browser_snapshot/)
    // Nothing was pressed, so the decoy underneath was left alone.
    expect(await tab.title()).toBe("idle")
  })

  test("something that covers the element while the cursor travels stops the click", async () => {
    await tab.navigate(`${webUrl}/moving`, "load", 20_000)
    await travelling("cover")
    expect(await failure(tab.click("#mover"))).toMatch(/covered by/)
    expect(await tab.title()).toBe("idle")
  })

  test("a framework that recreates the node keeps working through the same ref", async () => {
    await tab.navigate(`${webUrl}/moving`, "load", 20_000)
    const snapshot = await tab.snapshot()
    const ref = /ref_\d+/.exec(snapshot.outline.split("\n").find((line) => line.includes('"Mover"'))!)![0]
    await travelling("recreate")
    await BrowserPage.perform(tab, { action: "click", ref }, 10_000)
    // The handler of the new node ran, so the click reached the replacement.
    expect(await tab.title()).toBe("recreated")
  })

  test("a recreated node that lost its ref is relocated by its identity", async () => {
    await tab.navigate(`${webUrl}/moving`, "load", 20_000)
    const snapshot = await tab.snapshot()
    const ref = /ref_\d+/.exec(snapshot.outline.split("\n").find((line) => line.includes('"Mover"'))!)![0]
    await travelling("recreate-bare")
    await BrowserPage.perform(tab, { action: "click", ref }, 10_000)
    expect(await tab.title()).toBe("recreated")
  })

  /** Replaces the Mover button with `copies` fresh nodes, the way a re-render does. */
  function rebuild(copies: number) {
    return tab.evaluate(`(() => {
      const mover = document.getElementById("mover")
      const made = []
      for (let index = 0; index < ${copies}; index++) {
        const fresh = mover.cloneNode(true)
        fresh.removeAttribute("data-oc-ref")
        fresh.id = "mover" + (index || "")
        fresh.style.top = 100 + index * 120 + "px"
        made.push(fresh)
      }
      mover.replaceWith(...made)
    })()`)
  }

  test("a page that rebuilt its nodes keeps the refs the model already has", async () => {
    await tab.navigate(`${webUrl}/moving`, "load", 20_000)
    const before = await tab.snapshot()
    const ref = /ref_\d+/.exec(lines(before.outline).find((line) => line.includes('"Mover"'))!)![0]
    await rebuild(1)
    const after = await tab.snapshot()
    expect(lines(after.outline).find((item) => item.includes('"Mover"'))).toContain(ref)
    // So what reaches the model is the change, not the whole page again.
    expect(BrowserPage.renderChange(before, after)).not.toBe(BrowserPage.render(after))
    // And the ref still acts on the element it names.
    await BrowserPage.perform(tab, { action: "click", ref }, 10_000)
    expect(await tab.title()).toBe("mover")
  })

  test("a rebuilt element that is now one of a pair is given a new ref instead of a guess", async () => {
    await tab.navigate(`${webUrl}/moving`, "load", 20_000)
    const before = await tab.snapshot()
    const ref = /ref_\d+/.exec(lines(before.outline).find((line) => line.includes('"Mover"'))!)![0]
    await rebuild(2)
    const after = await tab.snapshot()
    const twins = lines(after.outline).filter((line) => line.includes('"Mover"'))
    expect(twins).toHaveLength(2)
    // Neither twin may inherit the old ref: which of them it meant is unknowable.
    for (const twin of twins) expect(twin).not.toContain(ref + "]")
  })

  test("two identity matches fail instead of choosing a recreated twin", async () => {
    await tab.navigate(`${webUrl}/moving`, "load", 20_000)
    const snapshot = await tab.snapshot()
    const ref = /ref_\d+/.exec(snapshot.outline.split("\n").find((line) => line.includes('"Mover"'))!)![0]
    await travelling("recreate-twins")
    const message = await failure(BrowserPage.perform(tab, { action: "click", ref }, 10_000))
    expect(message).toMatch(/more than one element.*fresh browser_snapshot/i)
    expect(message).not.toContain("\n")
    expect(message).not.toContain("at ")
    expect(await tab.title()).toBe("idle")
  })

  test("an element in open shadow DOM appears in the outline and can be clicked", async () => {
    await tab.navigate(`${webUrl}/shadow`, "load", 20_000)
    const snapshot = await tab.snapshot()
    const line = snapshot.outline.split("\n").find((item) => item.includes('button "Open action"'))!
    await BrowserPage.perform(tab, { action: "click", ref: /ref_\d+/.exec(line)![0] }, 10_000)
    expect(await tab.title()).toBe("open clicked")
  })

  test("nested open shadow DOM is traversed and acted on", async () => {
    await tab.navigate(`${webUrl}/shadow`, "load", 20_000)
    const snapshot = await tab.snapshot()
    const line = snapshot.outline.split("\n").find((item) => item.includes('button "Nested action"'))!
    await BrowserPage.perform(tab, { action: "click", ref: /ref_\d+/.exec(line)![0] }, 10_000)
    expect(await tab.title()).toBe("nested clicked")
  })

  test("a partially covered shadow element is not mistaken for being covered by its host", async () => {
    await tab.navigate(`${webUrl}/shadow`, "load", 20_000)
    const snapshot = await tab.snapshot()
    const line = snapshot.outline.split("\n").find((item) => item.includes('button "Open action"'))!
    expect(await failure(tab.click(BrowserSnapshot.locator(/ref_\d+/.exec(line)![0])))).toBe("")
    expect(await tab.title()).toBe("open clicked")
  })

  test("a closed shadow root stays out of the outline without breaking the page", async () => {
    await tab.navigate(`${webUrl}/shadow`, "load", 20_000)
    const snapshot = await tab.snapshot()
    expect(snapshot.outline).not.toContain("Closed action")
    expect(snapshot.outline).toContain("Open action")
  })

  test("a cover that goes away on its own is waited out and the action is tried once more", async () => {
    await tab.navigate(`${webUrl}/transient`, "load", 20_000)
    await tab.evaluate("window.coverFor(400)")
    const verdict = await BrowserPage.perform(tab, { action: "click", selector: "#target" }, 10_000)
    expect(verdict.attempts).toBe(2)
    expect(await tab.title()).toBe("clicked")
  })

  test("a cover that stays put fails rather than being retried forever", async () => {
    await tab.navigate(`${webUrl}/transient`, "load", 20_000)
    await tab.evaluate("window.coverFor(60000)")
    const started = Date.now()
    expect(await failure(BrowserPage.perform(tab, { action: "click", selector: "#target" }, 10_000))).toMatch(
      /covered by/,
    )
    // Two attempts and the wait between them, not a loop.
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(await tab.title()).toBe("idle")
  })

  test("a page that takes the wheel over from the browser is still scrolled", async () => {
    await tab.navigate(`${webUrl}/hijack`, "load", 20_000)
    const offset = () => tab.evaluate<string>("document.getElementById('content').style.transform")
    expect(await offset()).toBe("translateY(0px)")
    const verdict = await BrowserPage.perform(tab, { action: "scroll", direction: "down", amount: 400 }, 10_000)
    // Nothing here is scrollable, so only a real wheel event moves it.
    expect(await offset()).not.toBe("translateY(0px)")
    expect(verdict.outcome).toBe("success_confirmed")
    expect(verdict.signals.join(" ")).toContain("scrolled down")
  })

  test("a scroll that moves nothing is reported instead of passing as done", async () => {
    await tab.navigate(`${webUrl}/short`, "load", 20_000)
    const verdict = await BrowserPage.perform(tab, { action: "scroll", direction: "down" }, 10_000)
    expect(verdict.outcome).toBe("success_no_visible_change")
    expect(verdict.signals.join(" ")).toContain("nothing scrolled")
  })

  test("a box that scrolls on its own is scrolled where the pointer is", async () => {
    await tab.navigate(`${webUrl}/container`, "load", 20_000)
    const top = () => tab.evaluate<number>("document.getElementById('box').scrollTop")
    expect(await top()).toBe(0)
    const verdict = await BrowserPage.perform(
      tab,
      { action: "scroll", selector: "#box", direction: "down", amount: 300 },
      10_000,
    )
    expect(await top()).toBeGreaterThan(0)
    expect(verdict.outcome).toBe("success_confirmed")
  })

  test("the page itself scrolls without a target", async () => {
    await tab.navigate(`${webUrl}/stripes`, "load", 20_000)
    await tab.evaluate("scrollTo(0, 0)")
    const verdict = await BrowserPage.perform(tab, { action: "scroll", direction: "down", amount: 500 }, 10_000)
    expect(await tab.evaluate<number>("scrollY")).toBeGreaterThan(0)
    expect(verdict.outcome).toBe("success_confirmed")
  })

  test("a button at the bottom of a scrolling box is reached", async () => {
    await tab.navigate(`${webUrl}/container`, "load", 20_000)
    await BrowserPage.perform(tab, { action: "click", selector: "#deep" }, 10_000)
    expect(await tab.title()).toBe("deep")
  })

  test("a screenshot of an element far down the page captures that element", async () => {
    await tab.navigate(`${webUrl}/stripes`, "load", 20_000)
    await tab.evaluate("scrollTo(0, 0)")
    // Measuring scrolls the element into view, which moves the page under the
    // clip: the offset has to be read after that, not before.
    const shot = await tab.screenshot({ selector: "#far" })
    expect(near(await centre(shot), [255, 0, 0])).toBe(true)
    // And the same picture again now that no scrolling is needed.
    const again = await tab.screenshot({ selector: "#far" })
    expect(near(await centre(again), [255, 0, 0])).toBe(true)
  })

  test("a screenshot of an element already on screen is unaffected", async () => {
    await tab.navigate(`${webUrl}/stripes`, "load", 20_000)
    await tab.evaluate("scrollTo(0, 0)")
    expect(near(await centre(await tab.screenshot({ selector: "#near" })), [0, 0, 255])).toBe(true)
  })

  test("each character arrives as the key it comes from", async () => {
    await tab.navigate(`${webUrl}/typing`, "load", 20_000)
    const seen = () => tab.evaluate<string>("document.getElementById('keys').textContent")
    await BrowserPage.perform(tab, { action: "type", selector: "#plain", text: "a" }, 10_000)
    expect(await seen()).toBe("a|KeyA|65|plain")
    await BrowserPage.perform(tab, { action: "type", selector: "#plain", text: "@" }, 10_000)
    expect(await seen()).toBe("@|Digit2|50|shift")
    await BrowserPage.perform(tab, { action: "type", selector: "#plain", text: "7" }, 10_000)
    expect(await seen()).toBe("7|Digit7|55|plain")
  })

  test("a field that masks what is typed into it gets keys, not pasted text", async () => {
    await tab.navigate(`${webUrl}/typing`, "load", 20_000)
    const verdict = await BrowserPage.perform(tab, { action: "fill", selector: "#phone", text: "11999998888" }, 10_000)
    // The mask only ever runs from key events; text handed to the field would
    // have landed unmasked.
    expect(await tab.evaluate<string>("document.getElementById('phone').value")).toBe("(11) 99999-8888")
    expect(verdict.signals.join(" ")).toContain("key by key")
  })

  test("a field that throws away what it did not see a key for is typed into on a second pass", async () => {
    await tab.navigate(`${webUrl}/typing`, "load", 20_000)
    const verdict = await BrowserPage.perform(tab, { action: "fill", selector: "#picky", text: "ana" }, 10_000)
    expect(await tab.evaluate<string>("document.getElementById('picky').value")).toBe("ana")
    expect(verdict.signals.join(" ")).toContain("key by key")
  })

  test("an ordinary field still takes the fast path", async () => {
    await tab.navigate(`${webUrl}/typing`, "load", 20_000)
    const verdict = await BrowserPage.perform(tab, { action: "fill", selector: "#plain", text: "Maria" }, 10_000)
    expect(await tab.evaluate<string>("document.getElementById('plain').value")).toBe("Maria")
    expect(verdict.signals.join(" ")).not.toContain("key by key")
  })

  test("an autocomplete that listens for keys is triggered by typing", async () => {
    await tab.navigate(`${webUrl}/typing`, "load", 20_000)
    const shown = () => tab.evaluate<number>("document.getElementById('suggestions').children.length")
    expect(await shown()).toBe(0)
    await BrowserPage.perform(tab, { action: "type", selector: "#search", text: "Bras" }, 10_000)
    // "Brasil" and "Brasilia", not "Braganca".
    expect(await shown()).toBe(2)
  })

  test("keys can be held while clicking", async () => {
    await tab.navigate(`${webUrl}/gestures`, "load", 20_000)
    const result = () => tab.evaluate<string>("document.getElementById('result').textContent")
    await BrowserPage.perform(tab, { action: "click", selector: "#keys", modifiers: ["Control"] }, 10_000)
    expect(await result()).toBe("click:ctrl")
    await BrowserPage.perform(tab, { action: "click", selector: "#keys", modifiers: ["Shift", "Alt"] }, 10_000)
    expect(await result()).toBe("click:shiftalt")
    await BrowserPage.perform(tab, { action: "click", selector: "#keys" }, 10_000)
    expect(await result()).toBe("click:")
  })

  test("dragging one element onto another moves the pointer the whole way", async () => {
    await tab.navigate(`${webUrl}/gestures`, "load", 20_000)
    await BrowserPage.perform(tab, { action: "drag", selector: "#handle", to_selector: "#zone" }, 10_000)
    const result = await tab.evaluate<string>("document.getElementById('result').textContent")
    // A page that follows the pointer needs the moves in between, not a jump.
    expect(result).toMatch(/^dropped:/)
    expect(Number(result.split(":")[1])).toBeGreaterThan(4)
  })

  test("a draggable element uses native HTML5 drag and drop", async () => {
    await tab.navigate(`${webUrl}/gestures`, "load", 20_000)
    await BrowserPage.perform(tab, { action: "drag", selector: "#native", to_selector: "#native-zone" }, 10_000)
    expect(await tab.evaluate<string>("document.getElementById('result').textContent")).toBe("native:native payload")
  })

  test("a mouse drag measures its destination after the press reflows the page", async () => {
    await tab.navigate(`${webUrl}/gestures`, "load", 20_000)
    await BrowserPage.perform(tab, { action: "drag", selector: "#reflow-handle", to_selector: "#reflow-zone" }, 10_000)
    expect(await tab.evaluate<string>("document.getElementById('result').textContent")).toBe("reflowed")
  })

  test("a cancelled native drag falls back to a clean mouse drag", async () => {
    await tab.navigate(`${webUrl}/gestures`, "load", 20_000)
    await BrowserPage.perform(tab, { action: "drag", selector: "#fallback", to_selector: "#fallback-zone" }, 10_000)
    expect(await tab.evaluate<string>("document.getElementById('result').textContent")).toBe("mouse fallback")
  })

  test("a gesture can be built by hand from a press and a release", async () => {
    await tab.navigate(`${webUrl}/gestures`, "load", 20_000)
    await BrowserPage.perform(tab, { action: "mouse_down", selector: "#handle" }, 10_000)
    await BrowserPage.perform(tab, { action: "mouse_up", selector: "#zone" }, 10_000)
    expect(await tab.evaluate<string>("document.getElementById('result').textContent")).toMatch(/^dropped:/)
  })

  test("a drag without anywhere to drop says so", async () => {
    await tab.navigate(`${webUrl}/gestures`, "load", 20_000)
    expect(await failure(BrowserPage.perform(tab, { action: "drag", selector: "#handle" }, 10_000))).toMatch(
      /needs to_ref or to_selector/,
    )
  })

  test("a file is put into a file input the way a person picking it would", async () => {
    await tab.navigate(`${webUrl}/gestures`, "load", 20_000)
    const attachment = path.join(profile, "anexo.txt")
    fs.writeFileSync(attachment, "conteudo")
    const verdict = await BrowserPage.perform(
      tab,
      { action: "upload_file", selector: "#file", file: attachment },
      10_000,
    )
    expect(await tab.evaluate<string>("document.getElementById('result').textContent")).toBe("file:anexo.txt")
    expect(verdict.outcome).toBe("success_confirmed")
  })

  test("a file that is not there, or a path that is not absolute, is refused before the page sees anything", async () => {
    await tab.navigate(`${webUrl}/gestures`, "load", 20_000)
    expect(
      await failure(
        BrowserPage.perform(
          tab,
          { action: "upload_file", selector: "#file", file: path.join(profile, "nope.txt") },
          10_000,
        ),
      ),
    ).toMatch(/There is no file at/)
    expect(
      await failure(BrowserPage.perform(tab, { action: "upload_file", selector: "#file", file: "anexo.txt" }, 10_000)),
    ).toMatch(/not an absolute path/)
    expect(await tab.evaluate<string>("document.getElementById('result').textContent")).toBe("none")
  })

  test("a click that changes nothing says so instead of claiming success", async () => {
    await tab.navigate(webUrl, "load", 20_000)
    const verdict = await BrowserPage.perform(tab, { action: "click", selector: "#inert" }, 10_000)
    expect(verdict.outcome).toBe("success_no_visible_change")
  })

  test("a checkbox that was ticked is a confirmed action", async () => {
    await tab.navigate(webUrl, "load", 20_000)
    const verdict = await BrowserPage.perform(tab, { action: "check", selector: "#box" }, 10_000)
    expect(verdict.outcome).toBe("success_confirmed")
    expect(verdict.signals.join(" ")).toContain("checked")
  })

  test("a click that leaves the page is reported as a navigation", async () => {
    await tab.navigate(webUrl, "load", 20_000)
    const verdict = await BrowserPage.perform(tab, { action: "click", selector: "#away" }, 20_000)
    expect(verdict.outcome).toBe("navigation")
    expect(await tab.title()).toBe("Stripes")
  })

  test("acting on a ref that is gone reports a failure, and the trace stays empty when it is off", async () => {
    await tab.navigate(webUrl, "load", 20_000)
    expect(await failure(BrowserPage.perform(tab, { action: "click", ref: "ref_99999" }, 5_000))).toMatch(
      /fresh browser_snapshot/,
    )
    expect(tab.trace).toBeUndefined()
  })

  test("the probe reads state without reading what the page says", async () => {
    await tab.navigate(webUrl, "load", 20_000)
    const reading = await ActionVerifier.probe(tab, BrowserSnapshot.locator("ref_99999"))
    expect(reading?.present).toBe(false)
    const box = await ActionVerifier.probe(tab, "#box")
    expect(box?.present).toBe(true)
    expect(box?.checked).toBe(false)
  })
})
