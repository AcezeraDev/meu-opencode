import path from "path"
import { afterAll, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Browser } from "@/browser/session"
import { BrowserInstall } from "@/browser/install"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { BrowserActTool } from "../../src/tool/browser_act"
import { BrowserBatchTool } from "../../src/tool/browser_batch"
import { BrowserNavigateTool } from "../../src/tool/browser_navigate"
import { BrowserScriptTool } from "../../src/tool/browser_script"
import { BrowserNotesTool } from "../../src/tool/browser_notes"
import { SessionID, MessageID } from "../../src/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

/**
 * The browser tools as the model calls them, on a small copy of the Moodle quiz
 * flow the agent struggled with: a form post that redirects to the attempt.
 */
const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  )

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/start") return new Response(null, { status: 303, headers: { location: "/attempt" } })
    if (url.pathname === "/attempt") return page("Tentativa", `<p>Questão 1</p><button>Próxima página</button>`)
    if (url.pathname === "/list") {
      // Three pages of three lessons, each page linking to the next.
      const number = Number(url.searchParams.get("page") ?? "1")
      const items = [1, 2, 3].map(
        (index) => `<li><a href="/lesson/${number}-${index}">Aula ${number}.${index}</a></li>`,
      )
      const next = number < 3 ? `<a href="/list?page=${number + 1}">Próxima</a>` : ""
      return page(`Lista ${number}`, `<ul>${items.join("")}</ul>${next}`)
    }
    if (url.pathname === "/opener") return page("Aula", `<a href="/material" target="_blank">Material da aula</a>`)
    if (url.pathname === "/material") return page("Material", `<p>Formas normais</p><button>Baixar</button>`)
    // A quiz that shows its question only once started, as Moodle's do.
    const quiz = url.searchParams.get("id")
    if (url.pathname === "/q")
      return page(`Quiz ${quiz}`, `<form method="post" action="/q/start?id=${quiz}"><button>Começar</button></form>`)
    if (url.pathname === "/q/start")
      return new Response(null, { status: 303, headers: { location: `/q/attempt?id=${quiz}` } })
    if (url.pathname === "/q/attempt") {
      return page(
        `Tentativa ${quiz}`,
        `<form method="get" action="/q/result"><input type="hidden" name="id" value="${quiz}"><label><input type="radio" name="a" value="0"> Errada</label><label><input type="radio" name="a" value="1"> Certa</label><button>Enviar</button></form>`,
      )
    }
    if (url.pathname === "/q/result")
      return page(`Resultado ${url.searchParams.get("a") === "1" ? "certo" : "errado"}`, "")
    return page(
      "Quiz",
      `<form method="post" action="/start"><button>Iniciar tentativa</button></form><button>Ajuda</button>`,
    )
  },
})
afterAll(() => server.stop(true))

const it = testEffect(
  LayerNode.compile(LayerNode.group([Browser.node, Truncate.node, Agent.node]), [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
        get: () => Effect.succeed({ browser: { headless: true, profile: "test-tools", timeout: 20_000 } }),
      }),
    ],
  ]),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const describeBrowser = BrowserInstall.available() ? describe : describe.skip

/** What a program returned: the output's first block, before its logs and the page it ended on. */
const returned = (output: string) => JSON.parse(output.split("\n\n")[0]!)

describeBrowser("browser tools", () => {
  it.instance(
    "a batch that opens another page stops before steps aimed at refs of the page before",
    () =>
      Effect.gen(function* () {
        const navigate = yield* (yield* BrowserNavigateTool).init()
        const opened = yield* navigate.execute({ url: `http://127.0.0.1:${server.port}/quiz` }, ctx)
        const start = /"Iniciar tentativa" \[(ref_\d+)/.exec(opened.output)?.[1]
        const help = /"Ajuda" \[(ref_\d+)/.exec(opened.output)?.[1]
        expect(start).toBeDefined()
        expect(help).toBeDefined()

        const batch = yield* (yield* BrowserBatchTool).init()
        const started = Date.now()
        const result = yield* batch.execute(
          {
            steps: [
              { action: "click", ref: start },
              { action: "click", ref: help },
            ],
          },
          ctx,
        )
        expect(result.output).toContain("Stopped after step 1 of 2: it opened another page")
        expect(result.output).toContain("2. click")
        expect(result.output).toContain("not run")
        // The new page's refs come back with it, ready for the next call.
        expect(result.output).toContain("Próxima página")
        expect(result.metadata.done).toBe(1)
        expect(Date.now() - started).toBeLessThan(10_000)

        const browser = yield* Browser.Service
        yield* browser.shutdown()
      }),
    60_000,
  )

  it.instance(
    "a click on a link that opens a new tab reports that tab, not an unchanged page",
    () =>
      Effect.gen(function* () {
        const navigate = yield* (yield* BrowserNavigateTool).init()
        const opened = yield* navigate.execute({ url: `http://127.0.0.1:${server.port}/opener` }, ctx)
        const link = /"Material da aula" \[(ref_\d+)/.exec(opened.output)?.[1]
        expect(link).toBeDefined()

        const act = yield* (yield* BrowserActTool).init()
        const result = yield* act.execute({ action: "click", ref: link }, ctx)
        expect(result.output).toContain("it opened a new tab, and the browser switched to it")
        expect(result.output).toContain("Formas normais")
        expect(result.output).toContain('button "Baixar"')

        // The next action goes to the new tab.
        const browser = yield* Browser.Service
        const active = yield* browser.tab()
        expect(yield* Effect.promise(() => active.title())).toBe("Material")
        yield* browser.shutdown()
      }),
    60_000,
  )

  it.instance(
    "a program goes through every page of a list in one call, and can be saved and run again by name",
    () =>
      Effect.gen(function* () {
        const navigate = yield* (yield* BrowserNavigateTool).init()
        yield* navigate.execute({ url: `http://127.0.0.1:${server.port}/list` }, ctx)

        const script = yield* (yield* BrowserScriptTool).init()
        const code = `
          const found = []
          for (let pages = 0; pages < 10; pages++) {
            const page = await tools.page.snapshot()
            for (const element of page.elements) {
              if (element.role === "link" && element.name.startsWith(args.prefix)) found.push(element.name)
            }
            const next = page.elements.find((element) => element.name === "Próxima")
            if (!next) break
            await tools.page.act({ action: "click", ref: next.ref })
          }
          console.log("pages read")
          return found
        `
        const first = yield* script.execute({ code, name: "todas-as-aulas", args: { prefix: "Aula" } }, ctx)
        const lessons = returned(first.output)
        expect(lessons).toEqual([
          "Aula 1.1",
          "Aula 1.2",
          "Aula 1.3",
          "Aula 2.1",
          "Aula 2.2",
          "Aula 2.3",
          "Aula 3.1",
          "Aula 3.2",
          "Aula 3.3",
        ])
        expect(first.output).toContain("pages read")
        expect(first.output).toContain("Page now:")
        expect(first.output).toContain("list?page=3")
        expect(first.metadata.saved).toBe("todas-as-aulas")

        // Saved, it runs again from its name alone, with other arguments.
        yield* navigate.execute({ url: `http://127.0.0.1:${server.port}/list` }, ctx)
        const again = yield* script.execute({ name: "todas-as-aulas", args: { prefix: "Aula 2" } }, ctx)
        expect(returned(again.output)).toEqual(["Aula 2.1", "Aula 2.2", "Aula 2.3"])

        const browser = yield* Browser.Service
        yield* browser.shutdown()
      }),
    90_000,
  )

  it.instance(
    "a program has only the page functions: no files, no process, no network",
    () =>
      Effect.gen(function* () {
        const navigate = yield* (yield* BrowserNavigateTool).init()
        yield* navigate.execute({ url: `http://127.0.0.1:${server.port}/list` }, ctx)
        const script = yield* (yield* BrowserScriptTool).init()
        for (const code of [
          `return process.env`,
          `return require("fs").readdirSync(".")`,
          `return await fetch("https://example.com")`,
          `return await import("fs")`,
          `return (() => {}).constructor("return process")()`,
        ]) {
          const exit = yield* Effect.exit(script.execute({ code }, ctx))
          expect(exit._tag).toBe("Failure")
        }
        const browser = yield* Browser.Service
        yield* browser.shutdown()
      }),
    60_000,
  )

  it.instance(
    "what was learned on a site is kept for it and told the first time a later session lands there",
    () =>
      Effect.gen(function* () {
        const first = { ...ctx, sessionID: SessionID.make("ses_site_first") }
        const later = { ...ctx, sessionID: SessionID.make("ses_site_later") }
        const host = `127.0.0.1:${server.port}`
        const navigate = yield* (yield* BrowserNavigateTool).init()

        const landed = yield* navigate.execute({ url: `http://${host}/list` }, first)
        expect(landed.output).toContain(`<site-memory host="${host}">`)
        // Said once per session.
        const again = yield* navigate.execute({ url: `http://${host}/list?page=2` }, first)
        expect(again.output).not.toContain("<site-memory")

        const notes = yield* (yield* BrowserNotesTool).init()
        const noted = yield* notes.execute({ add: "The lesson list has three pages, linked by Próxima." }, first)
        expect(noted.output).toContain("1. The lesson list has three pages")

        const script = yield* (yield* BrowserScriptTool).init()
        const saved = yield* script.execute(
          {
            name: "proxima-lista",
            description: "Goes to the next page of the lesson list.",
            code: `
              const next = await tools.page.find({ name: "Próxima", role: "link" })
              if (!next) return { moved: false }
              const result = await tools.page.act({ action: "click", ref: next.ref })
              return { moved: true, url: result.url }
            `,
          },
          first,
        )
        expect(returned(saved.output)).toEqual({ moved: true, url: `http://${host}/list?page=3` })
        expect(saved.output).toContain(`for ${host}`)

        const told = yield* navigate.execute({ url: `http://${host}/list` }, later)
        expect(told.output).toContain("1. The lesson list has three pages, linked by Próxima.")
        expect(told.output).toContain("- proxima-lista: Goes to the next page of the lesson list.")

        // Run by name alone, on the site it was saved for.
        const ran = yield* script.execute({ name: "proxima-lista" }, later)
        expect(returned(ran.output)).toEqual({ moved: true, url: `http://${host}/list?page=2` })

        const removed = yield* notes.execute({ remove: [1] }, later)
        expect(removed.output).toBe(`No notes for ${host}.`)

        const browser = yield* Browser.Service
        yield* browser.shutdown()
      }),
    90_000,
  )

  it.instance(
    "a routine done by hand a second time is saved as a program for the site, and said once",
    () =>
      Effect.gen(function* () {
        const session = { ...ctx, sessionID: SessionID.make("ses_site_routine") }
        const navigate = yield* (yield* BrowserNavigateTool).init()
        const act = yield* (yield* BrowserActTool).init()
        const round = () =>
          Effect.gen(function* () {
            const list = yield* navigate.execute({ url: `http://127.0.0.1:${server.port}/list` }, session)
            const next = /"Próxima" \[(ref_\d+)/.exec(list.output)?.[1]
            const second = yield* act.execute({ action: "click", ref: next }, session)
            const lesson = /"Aula 2\.1" \[(ref_\d+)/.exec(second.output)?.[1]
            return yield* act.execute({ action: "click", ref: lesson }, session)
          })

        const once = yield* round()
        expect(once.output).not.toContain("same routine")
        const twice = yield* round()
        expect(twice.output).toContain("same routine")
        expect(twice.output).toContain("open /list")
        expect(twice.output).toContain('click link "Próxima"')
        expect(twice.output).toContain('click link "Aula 2.1"')
        const thrice = yield* round()
        expect(thrice.output).not.toContain("same routine")

        // Saved from the steps, it repeats the routine in one call, by name.
        const name = /saved for this site as the program "([^"]+)"/.exec(twice.output)?.[1]
        expect(name).toBe("rotina-proxima")
        yield* navigate.execute({ url: `http://127.0.0.1:${server.port}/list` }, session)
        const script = yield* (yield* BrowserScriptTool).init()
        const ran = yield* script.execute({ name: name! }, session)
        expect(returned(ran.output)).toEqual({ done: true, url: `http://127.0.0.1:${server.port}/lesson/2-1` })

        const browser = yield* Browser.Service
        yield* browser.shutdown()
      }),
    90_000,
  )

  it.instance(
    "a learned quiz routine picks up after the start done by hand, and stops where an answer is missing",
    () =>
      Effect.gen(function* () {
        const session = { ...ctx, sessionID: SessionID.make("ses_site_quiz") }
        const base = `http://127.0.0.1:${server.port}`
        const navigate = yield* (yield* BrowserNavigateTool).init()
        const act = yield* (yield* BrowserActTool).init()
        const ref = (output: string, name: string) => new RegExp(`"${name}" \\[(ref_\\d+)`).exec(output)?.[1]
        const start = (id: number) =>
          Effect.gen(function* () {
            const opened = yield* navigate.execute({ url: `${base}/q?id=${id}` }, session)
            return yield* act.execute({ action: "click", ref: ref(opened.output, "Começar") }, session)
          })
        const answer = (id: number) =>
          Effect.gen(function* () {
            const attempt = yield* start(id)
            const picked = yield* act.execute({ action: "click", ref: ref(attempt.output, "Certa") }, session)
            const sent = yield* act.execute(
              { action: "click", ref: ref(picked.output, "Enviar") ?? ref(attempt.output, "Enviar") },
              session,
            )
            // Everything the round was told, since the routine is found at the step that completes it.
            return [attempt.output, picked.output, sent.output].join("\n")
          })
        yield* answer(1)
        const learned = yield* answer(2)
        const name = /saved for this site as the program "([^"]+)"/.exec(learned)?.[1]
        expect(name).toBe("rotina-comecar")

        const script = yield* (yield* BrowserScriptTool).init()
        // Started by hand to read the question, then the rest in one call.
        yield* start(3)
        const rest = yield* script.execute({ name: name!, args: { answers: ["Certa"] } }, session)
        expect(returned(rest.output)).toEqual({ done: true, url: `${base}/q/result?id=3&a=1` })

        // From the start, without the answer: it starts the quiz and stops to ask for it.
        yield* navigate.execute({ url: `${base}/q?id=4` }, session)
        const asked = yield* script.execute({ name: name! }, session)
        expect(returned(asked.output)).toMatchObject({
          done: false,
          why: "pass args.answers[0]",
          url: `${base}/q/attempt?id=4`,
        })

        const browser = yield* Browser.Service
        yield* browser.shutdown()
      }),
    120_000,
  )
})
