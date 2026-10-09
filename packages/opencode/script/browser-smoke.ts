#!/usr/bin/env bun
/**
 * Smoke test of the browsing agent the way the desktop app runs it.
 *
 * The app runs this server under Node, from the bundle `build-node.ts` makes,
 * while `bun test` runs the sources under Bun. A `Bun.*` call in server code
 * passes every test and breaks every browser tool in the app. So this builds
 * that same bundle, runs it under Node with its own data folders, and has a
 * scripted fake model call each browser tool against a local lab site through
 * a real session. Nothing here uses a paid model or the person's own browser.
 *
 * Two runs:
 * - process mode: the server launches its own headless browser;
 * - extension mode: a fake of the Brave extension pairs over the same socket
 *   the real one uses and drives a headless Edge through CDP, and restarts in
 *   the middle of the run, the way the browser restarts the extension's worker.
 *
 *   bun script/browser-smoke.ts
 *
 * Exits 1 and lists what failed when any tool errored or said something wrong.
 */

import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Script } from "@opencode-ai/script"
import { BrowserInstall } from "../src/browser/install"

const dir = path.resolve(import.meta.dir, "..")
process.chdir(dir)
const work = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-browser-smoke-"))
const log = (...args: unknown[]) => console.log("[smoke]", ...args)
const TOKEN = "smoke-extension-token"

// 1. The bundle the app loads, built as build-node.ts builds it.
log("building the Node bundle…")
const generated = await import("./generate.ts")
const bundle = path.join(dir, "dist", "smoke-node")
const built = await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  // Inside the package, so the modules left external resolve as the app's do.
  outdir: bundle,
  format: "esm",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: { "opencode-web-ui.gen.ts": "" },
})
if (!built.success) {
  console.error(built.logs)
  process.exit(1)
}

// 2. The lab: pages like the ones the agent meets on Moodle.
const PDF = (await import("../test/fixture/pdf")).makePdf(["Material da aula", "Formas normais"])
const office = await import("../test/fixture/office")
const DOCX = office.makeDocx(["Apostila", "Capítulo 1: normalização"])
const XLSX = office.makeXlsx([{ name: "Notas", rows: [["Aluno", "Nota"], ["Ana", 9.5]] }])
const lab = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url)
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
    if (url.pathname === "/doc.pdf") return new Response(PDF, { headers: { "content-type": "application/pdf" } })
    if (url.pathname === "/lesson")
      return html(
        `<title>Aula</title><h1>Aula 1</h1><a href="/doc.pdf">Material da aula</a> <a href="/mod/resource/view.php?id=5">Apostila</a>`,
      )
    // Like Moodle: the link says nothing of the file, which comes as an attachment.
    if (url.pathname === "/mod/resource/view.php")
      return new Response(DOCX, {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "content-disposition": 'attachment; filename="Apostila 1.docx"',
        },
      })
    if (url.pathname === "/upload")
      return html(`<title>Enviar</title><label>Arquivo <input type="file" onchange="document.title = 'Recebido ' + this.files[0].name + ' ' + this.files[0].size"></label>`)
    // Like Instagram's "create" dialog: a hidden file input, a caption and Share.
    if (url.pathname === "/instagram")
      return html(`<title>Instagram</title><nav><button onclick="document.getElementById('d').hidden = false">Criar</button></nav>
        <div id="d" role="dialog" aria-label="Criar nova publicação" hidden>
          <input type="file" accept="video/*" style="display:none"
            onchange="document.getElementById('f').textContent = 'Arquivo ' + this.files[0].name + ' ' + this.files[0].size; document.getElementById('c').hidden = false">
          <p id="f"></p>
          <div id="c" hidden><label>Legenda <textarea id="t"></textarea></label>
            <button onclick="document.getElementById('ok').textContent = 'Seu reel foi compartilhado: ' + document.getElementById('t').value">Compartilhar</button></div>
          <p id="ok"></p>
        </div>`)
    if (url.pathname === "/perfil")
      return html(`<title>Doces da Ana</title><h1>docesdaana</h1><p>Confeitaria caseira em BH 🍫 Encomendas pelo link</p>
        <article><p>Brigadeiro de colher pra adoçar a semana 💛 #brigadeiro #docecaseiro</p></article>
        <article><p>Bolo de pote saindo agora! Link na bio 🍰 #bolodepote #docecaseiro</p></article>`)
    if (url.pathname === "/login")
      return html(`<title>Entrar</title><form><label>Senha <input type="password"></label><button>Acessar</button></form>`)
    if (url.pathname === "/planilha.xlsx")
      return new Response(XLSX, {
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      })
    if (url.pathname === "/form")
      return html(`<title>Form</title><label>Nome <input id="n"></label>
        <button onclick="document.title = 'Enviado ' + document.getElementById('n').value">Enviar</button>`)
    if (url.pathname === "/embedded")
      return html(`<title>Recurso</title><object data="/doc.pdf" type="application/pdf" title="Apostila" width="400" height="300"></object>`)
    return html("<title>Lab</title>ok")
  },
})
const site = `http://127.0.0.1:${lab.port}`
// A file of the person's to send to a site.
const upload = path.join(work, "trabalho.txt")
await fs.writeFile(upload, "meu trabalho de casa")
// A video too big for one message through the extension, which goes in pieces.
const bigVideo = path.join(work, "video-grande.mp4")
const BIG_VIDEO_BYTES = 30 * 1024 * 1024 + 7
await fs.writeFile(bigVideo, Buffer.alloc(BIG_VIDEO_BYTES, 7))
// The video the social agent posts from the queue, and the post the queue made of it.
const socialVideo = path.join(work, "promo.mp4")
await fs.writeFile(socialVideo, Buffer.alloc(2048, 1))
const social = { id: "", video: "", session: "" }
// A still the app took from the video, as the page sends it when scheduling.
const STILL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAwAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AK0BHTp//9k="
const PREP_CAPTION = "Brigadeiro saindo do forno 🍫 Encomendas pelo link na bio! #brigadeiro #docecaseiro"

// 3. The fake model: one scripted step per tool result it has seen, from the
// script the first message names.
type Call = { tool: string; args: Record<string, unknown> } | { text: string }
type Step = (outputs: string[]) => Call | Promise<Call>
const ref = (outputs: string[], pattern: RegExp) => {
  for (const output of [...outputs].reverse()) {
    const match = pattern.exec(output)
    if (match) return match[1]
  }
  return "ref_missing"
}

interface Scenario {
  name: string
  browser: Record<string, unknown>
  /** Session metadata set before the prompt, such as look only. */
  metadata?: Record<string, unknown>
  /** Steps the server must refuse, by index. */
  refused?: number[]
  /**
   * Runs as the posting queue's clock would: a queued video, claimed by a
   * session of the social agent ("post"), or by one of the social-prep agent
   * ten minutes before, with the video's stills attached ("prep").
   */
  social?: "post" | "prep"
  steps: Step[]
  check: (
    out: (index: number) => string,
    expect: (label: string, holds: boolean) => void,
    ms: (index: number) => number,
    api: (method: string, route: string, body?: unknown) => Promise<any>,
  ) => void | Promise<void>
}

const extension = await startFakeExtension()

const SCENARIOS: Scenario[] = [
  {
    name: "process",
    browser: { mode: "process", headless: true, profile: "smoke", timeout: 20000 },
    steps: [
      () => ({ tool: "browser_navigate", args: { url: `${site}/lesson` } }),
      (o) => ({ tool: "browser_act", args: { action: "click", ref: ref(o, /link "Material da aula" \[(ref_\d+)/) } }),
      () => ({ tool: "browser_snapshot", args: {} }),
      () => ({ tool: "browser_navigate", args: { action: "back" } }),
      // A path, as the outline shows links to the page's own site.
      () => ({ tool: "browser_navigate", args: { url: "/form" } }),
      (o) => ({
        tool: "browser_batch",
        args: {
          steps: [
            { action: "fill", ref: ref(o, /textbox "Nome" \[(ref_\d+)/), text: "Ana" },
            { action: "click", ref: ref(o, /button "Enviar" \[(ref_\d+)/) },
          ],
        },
      }),
      () => ({ tool: "browser_screenshot", args: { marks: true } }),
      () => ({ tool: "browser_inspect", args: { what: "evaluate", expression: "document.title" } }),
      () => ({ tool: "browser_notes", args: { add: "O botão Enviar muda o título." } }),
      () => ({
        tool: "browser_script",
        args: { code: "const page = await tools.page.snapshot()\nreturn page.elements.length" },
      }),
      () => ({ tool: "browser_navigate", args: { url: `${site}/doc.pdf` } }),
      () => ({ tool: "browser_navigate", args: { url: `${site}/embedded` } }),
      () => ({ tool: "browser_navigate", args: { url: `${site}/lesson` } }),
      (o) => ({ tool: "browser_act", args: { action: "click", ref: ref(o, /link "Apostila" \[(ref_\d+)/) } }),
      () => ({ tool: "browser_navigate", args: { url: `${site}/planilha.xlsx` } }),
      () => ({ tool: "site_check", args: { url: `${site}/form`, crawl: 0, viewports: ["desktop", "mobile"] } }),
      () => ({ tool: "browser_navigate", args: { url: `${site}/form` } }),
      () => ({ tool: "browser_find", args: { query: "enviar" } }),
      () => ({ tool: "browser_snapshot", args: { interactive: true, maxChars: 400 } }),
      // A command that keeps running goes to the background, and is stopped by its id.
      () => ({ tool: "bash", args: { command: 'node -e "setInterval(() => console.log(1), 200)"', background: true } }),
      (o) => ({ tool: "shell_jobs", args: { action: "stop", id: ref(o, /background as (shell_[0-9a-f]+)/) } }),
      () => ({ tool: "preview", args: { path: "/form" } }),
    ],
    check: (out, expect) => {
      expect("the click on the PDF read its text", out(1).includes("Formas normais"))
      expect("the PDF opened in the viewer", out(1).includes("open in the browser tab"))
      expect("a snapshot of the viewer reads the PDF", out(2).includes("Material da aula"))
      expect("back returned to the lesson", out(3).includes("/lesson"))
      expect("a path opened on the page's site", out(4).includes(`${site}/form`))
      expect("links to the same site show by path", out(0).includes("href=/doc.pdf"))
      expect("the batch filled and clicked", out(7).includes("Enviado Ana"))
      expect("the script ran", /\d/.test(out(9)))
      expect("a marked screenshot lists its boxes", out(6).includes("Numbered boxes"))
      expect("navigating to a PDF opens it", out(10).includes("open in the browser tab"))
      expect("an embedded PDF is listed", out(11).includes('pdf "Apostila"'))
      expect("a click that downloads a Word file reads it", out(13).includes("Capítulo 1: normalização"))
      expect("navigating to a workbook reads it", out(14).includes("Ana\t9.5"))
      expect("a site check measured the page at two sizes", out(15).includes("1 página(s) × desktop, mobile"))
      expect("find lists the button it names", /button "Enviar" \[ref_\d+/.test(out(17)))
      expect("a snapshot reads only what can be acted on", out(18).includes("part: only what can be acted on"))
      expect("a command went to the background", out(19).includes("Running in the background as shell_"))
      expect("the background command was stopped", out(20).includes("Stopped shell_"))
      expect("preview opened the project's server", out(21).includes("A server already answers") && out(21).includes('button "Enviar"'))
    },
  },
  {
    name: "extension",
    browser: { mode: "extension", extensionToken: TOKEN, timeout: 20000 },
    steps: [
      () => ({ tool: "browser_navigate", args: { url: `${site}/form` } }),
      (o) => ({
        tool: "browser_batch",
        args: {
          steps: [
            { action: "fill", ref: ref(o, /textbox "Nome" \[(ref_\d+)/), text: "Ana" },
            { action: "click", ref: ref(o, /button "Enviar" \[(ref_\d+)/) },
          ],
        },
      }),
      // The extension's worker restarts right before this read, which lands while it is away.
      async () => {
        extension.restart(1500)
        return { tool: "browser_snapshot", args: {} }
      },
      () => ({ tool: "browser_inspect", args: { what: "evaluate", expression: "document.title" } }),
      // A navigation after the restart only finishes quickly if the tab's events were switched back on.
      () => ({ tool: "browser_navigate", args: { url: `${site}/lesson` } }),
      (o) => ({ tool: "browser_act", args: { action: "click", ref: ref(o, /link "Material da aula" \[(ref_\d+)/) } }),
      () => ({ tool: "browser_navigate", args: { url: `${site}/lesson` } }),
      (o) => ({ tool: "browser_act", args: { action: "click", ref: ref(o, /link "Apostila" \[(ref_\d+)/) } }),
      () => ({ tool: "browser_navigate", args: { url: `${site}/login` } }),
      () => ({ tool: "browser_navigate", args: { action: "ask_user", reason: "entrar na sua conta" } }),
      () => ({ tool: "browser_navigate", args: { url: `${site}/upload` } }),
      (o) => ({
        tool: "browser_act",
        args: { action: "upload_file", ref: ref(o, /"Arquivo" \[(ref_\d+)/), file: upload },
      }),
      () => ({ tool: "browser_inspect", args: { what: "evaluate", expression: "document.title" } }),
      () => ({ tool: "site_check", args: { url: `${site}/form`, crawl: 0, viewports: ["mobile"] } }),
      () => ({ tool: "browser_navigate", args: { url: `${site}/form` } }),
      () => ({ tool: "browser_find", args: { query: "nome", role: "textbox" } }),
      () => ({ tool: "browser_navigate", args: { url: `${site}/upload` } }),
      (o) => ({
        tool: "browser_act",
        args: { action: "upload_file", ref: ref(o, /"Arquivo" \[(ref_\d+)/), file: bigVideo },
      }),
      () => ({ tool: "browser_inspect", args: { what: "evaluate", expression: "document.title" } }),
    ],
    check: async (out, expect, ms) => {
      expect("a site check ran in the person's browser", out(13).includes("1 página(s) × mobile"))
      expect("the read during the restart saw the same page", out(2).includes("Enviado Ana") || out(2).includes("/form"))
      expect("the tab kept its page across the restart", out(3).includes("Enviado Ana"))
      expect("the navigation after the restart arrived", out(4).includes("/lesson"))
      expect(`the navigation after the restart was quick (${ms(4)} ms)`, ms(4) < 8000)
      // The one tab opened is the site check's own, at the end.
      expect("no new tab was opened for the restart", extension.created() === 1)
      expect("the click on a PDF read it through the extension", out(5).includes("Formas normais"))
      expect("the extension restarted once", extension.restarts() === 1)
      expect("a click that downloads a Word file reads it through the extension", out(7).includes("Capítulo 1"))
      expect("a login page says it is the user's to do", out(8).includes('action "ask_user"'))
      expect("the agent carried on once the user said it was done", out(9).includes("The user says it is done"))
      expect("the user was asked once", answered.length === 1 && answered[0]!.includes("entrar na sua conta"))
      expect("a file was sent although the browser refused to name it", out(12).includes("Recebido trabalho.txt 20"))
      expect("find works through the extension", out(15).includes('textbox "Nome"'))
      expect(
        "a video past one message's size was sent in pieces through the extension",
        out(18).includes(`Recebido video-grande.mp4 ${BIG_VIDEO_BYTES}`),
      )
    },
  },
  {
    // The social agent posts a queued video on an Instagram-like page and reports it.
    name: "social",
    browser: { mode: "process", headless: true, profile: "smoke-social", timeout: 20000 },
    social: "post",
    steps: [
      () => ({ tool: "browser_navigate", args: { url: `${site}/instagram` } }),
      (o) => ({ tool: "browser_act", args: { action: "click", ref: ref(o, /button "Criar" \[(ref_\d+)/) } }),
      () => ({
        tool: "browser_act",
        args: { action: "upload_file", selector: "input[type=file]", file: social.video },
      }),
      (o) => ({
        tool: "browser_batch",
        args: {
          steps: [
            { action: "fill", ref: ref(o, /textbox "Legenda" \[(ref_\d+)/), text: "Bastidores! #promo" },
            { action: "click", ref: ref(o, /button "Compartilhar" \[(ref_\d+)/) },
          ],
        },
      }),
      () => ({ tool: "browser_act", args: { action: "wait_for", text: "Seu reel foi compartilhado" } }),
      () => ({ tool: "social_report", args: { id: social.id, status: "posted", caption: "Bastidores! #promo" } }),
    ],
    check: async (out, expect, _ms, api) => {
      expect("the queued copy of the video was uploaded", out(2).includes("Arquivo") || out(3).includes("Arquivo"))
      expect("the page said the reel was shared", out(3).includes("Seu reel foi compartilhado: Bastidores! #promo"))
      expect("the report reached the queue", out(5).includes("posted on instagram"))
      const queue = await api("GET", "/experimental/social")
      const post = queue.posts.find((item: { id: string }) => item.id === social.id)
      expect("the post is marked posted with its caption", post?.status === "posted" && post?.posted === "Bastidores! #promo")
      expect("the posted video's copy was removed", !(await fs.stat(social.video).catch(() => undefined)))
      expect("the social agent is offered social_report", offered.get("social")?.has("social_report") === true)
      expect("the social agent is not offered the shell", offered.get("social")?.has("bash") === false)
      expect("other agents are not offered social_report", offered.get("process")?.has("social_report") === false)
    },
  },
  {
    // Ten minutes before, the social-prep agent reads the profile and leaves a caption the person can see.
    name: "legenda",
    browser: { mode: "process", headless: true, profile: "smoke-legenda", timeout: 20000 },
    social: "prep",
    steps: [
      () => ({ tool: "browser_navigate", args: { url: `${site}/perfil` } }),
      () => ({
        tool: "social_report",
        args: {
          id: social.id,
          status: "prepared",
          caption: PREP_CAPTION,
          analysis: "Mãos mexendo brigadeiro numa panela.",
          profile: "Confeitaria caseira em BH; tom carinhoso; #docecaseiro; CTA link na bio.",
        },
      }),
    ],
    check: async (out, expect, _ms, api) => {
      expect("the prep agent read the profile", out(0).includes("Confeitaria caseira"))
      expect("the caption reached the queue", out(1).includes("is ready"))
      const queue = await api("GET", "/experimental/social")
      const post = queue.posts.find((item: { id: string }) => item.id === social.id)
      expect("the post keeps the caption, still scheduled", post?.draft === PREP_CAPTION && post?.status === "scheduled")
      expect("the prep is done", post?.prep?.status === "done" && post?.analysis?.includes("brigadeiro"))
      expect("the profile summary was kept for next time", queue.profiles?.instagram?.summary?.includes("#docecaseiro"))
      expect("the still reached the model as an image", stills.has("legenda"))
      const tools = offered.get("legenda")
      expect("the prep agent is offered social_report", tools?.has("social_report") === true)
      expect(
        "the prep agent cannot batch, script or run the shell",
        tools?.has("browser_batch") === false && tools?.has("browser_script") === false && tools?.has("bash") === false,
      )
      // At its time, the posting agent gets the caption as a reference that types exactly.
      await api("PATCH", `/experimental/social/${social.id}`, { at: Date.now() - 1000 })
      const claimed = await api("POST", `/experimental/social/${social.id}/claim`, { sessionID: social.session })
      const id = /^@texto:([a-z0-9]+)$/.exec(claimed?.captionRef ?? "")?.[1]
      const saved = id
        ? await fs.readFile(path.join(work, "data", "opencode", "textos", `${id}.txt`), "utf8").catch(() => "")
        : ""
      expect("the claim hands the prepared caption as a write_text reference", saved === PREP_CAPTION)
    },
  },
  {
    // Look only: reading goes through, anything that acts on the page is refused.
    name: "look",
    browser: { mode: "process", headless: true, profile: "smoke-look", timeout: 20000 },
    metadata: { browserLook: true },
    refused: [2],
    // The last steps take no picture, so the earlier ones are on disk when checked.
    steps: [
      () => ({ tool: "browser_navigate", args: { url: `${site}/form` } }),
      () => ({ tool: "browser_act", args: { action: "scroll" } }),
      (o) => ({ tool: "browser_act", args: { action: "click", ref: ref(o, /button "Enviar" \[(ref_\d+)/) } }),
      () => ({ tool: "browser_snapshot", args: {} }),
    ],
    check: (out, expect) => {
      expect("look only let the page open", out(0).includes("/form"))
      expect("look only let the page scroll", !out(1).includes("Modo só olhar"))
      expect("look only refused the click", out(2).includes("Modo só olhar"))
      expect("look only let the page be read", out(3).includes('button "Enviar"'))
    },
  },
]

const toolsOffered = new Set<string>()
/** The tools each scenario's agent was offered. */
const offered = new Map<string, Set<string>>()
/** The scenarios whose model was sent an image. */
const stills = new Set<string>()
/** The questions the stand-in for the user answered, by their text. */
const answered: string[] = []
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json()) as {
      messages: { role: string; content: unknown }[]
      tools?: { function: { name: string } }[]
    }
    const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content))
    const outputs = body.messages.filter((message) => message.role === "tool").map((message) => text(message.content))
    const asked = text(body.messages.find((message) => message.role === "user")?.content ?? "")
    const scenario = SCENARIOS.find((item) => asked.includes(`roteiro ${item.name}`))
    for (const tool of body.tools ?? []) toolsOffered.add(tool.function.name)
    if (scenario && asked.includes("data:image/jpeg")) stills.add(scenario.name)
    if (scenario && body.tools?.length)
      offered.set(scenario.name, new Set(body.tools.map((tool) => tool.function.name)))
    // Titles and summaries ask without tools.
    const step = body.tools?.length && scenario ? scenario.steps[outputs.length] : undefined
    const call: Call = step ? await step(outputs) : { text: body.tools?.length ? "Pronto." : "Smoke" }
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const events =
      "tool" in call
        ? [
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${outputs.length}`,
                    type: "function",
                    function: { name: call.tool, arguments: JSON.stringify(call.args) },
                  },
                ],
              },
              null,
            ),
            chunk({}, "tool_calls"),
          ]
        : [chunk({ role: "assistant", content: call.text }, null), chunk({}, "stop")]
    return new Response([...events, "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } })
  },
})

// 4. One project per scenario, pointing at the fake model.
for (const scenario of SCENARIOS) {
  const project = path.join(work, `project-${scenario.name}`)
  await fs.mkdir(path.join(project, ".opencode"), { recursive: true })
  await fs.writeFile(
    path.join(project, ".opencode", "launch.json"),
    JSON.stringify({ configurations: [{ name: "lab", url: site }] }),
  )
  await fs.writeFile(
    path.join(project, ".opencode", "opencode.jsonc"),
    JSON.stringify({
      provider: {
        fake: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fake",
          options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fake" },
          // Sees images, as the model that writes captions from the stills must.
          models: {
            m: {
              name: "m",
              tool_call: true,
              attachment: true,
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 200000, output: 4096 },
            },
          },
        },
      },
      model: "fake/m",
      small_model: "fake/m",
      // The social agent runs on its own permissions, as with the person's config.
      ...(scenario.social ? {} : { permission: "allow" }),
      browser: scenario.browser,
    }),
  )
}

// 5. The server, under Node, from the bundle.
const runner = path.join(work, "runner.mjs")
const fileUrl = (file: string) => new URL(`file:///${file.replaceAll("\\", "/")}`).href
await fs.writeFile(
  runner,
  // node-pty is installed for the desktop app, which is what provides it there.
  `import { registerHooks } from "node:module"
const desktop = ${JSON.stringify(fileUrl(path.resolve(dir, "..", "desktop", "package.json")))}
registerHooks({
  resolve: (specifier, context, next) =>
    next(specifier, specifier.startsWith("@lydell/node-pty") ? { ...context, parentURL: desktop } : context),
})
const { Server } = await import(${JSON.stringify(fileUrl(path.join(bundle, "node.js")))})
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
console.log("LISTENING " + listener.url)
`,
)
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  XDG_DATA_HOME: path.join(work, "data"),
  XDG_CONFIG_HOME: path.join(work, "config"),
  XDG_STATE_HOME: path.join(work, "state"),
  XDG_CACHE_HOME: path.join(work, "cache"),
  OPENCODE_TEST_HOME: path.join(work, "home"),
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_BROWSER_EXTENSION_TOKEN: TOKEN,
}
delete env.OPENCODE_SERVER_PASSWORD
const server = Bun.spawn(["node", runner], { env, cwd: work, stdout: "pipe", stderr: "pipe" })
const serverLog: string[] = []
const failures: string[] = []
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the server did not start in 90 s")), 90_000)
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      const reader = stream.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) return
        const chunk = decoder.decode(next.value, { stream: true })
        serverLog.push(chunk)
        const match = /LISTENING (\S+)/.exec(chunk)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      }
    }
    void read(server.stdout)
    void read(server.stderr)
    void server.exited.then((code) => reject(new Error(`the server exited with ${code}:\n${serverLog.join("")}`)))
  })
  log("server (Node) at", base)
  extension.pair(base)

  for (const scenario of SCENARIOS) {
    log(`— ${scenario.name} mode`)
    await run(base, scenario)
  }
  for (const name of ["browser_navigate", "browser_act", "browser_batch", "browser_snapshot", "browser_screenshot"])
    if (!toolsOffered.has(name)) failures.push(`expected: the model is offered ${name}`)
} catch (error) {
  failures.push(String(error instanceof Error ? error.stack : error))
} finally {
  server.kill()
  await server.exited
  extension.stop()
  lab.stop(true)
  model.stop(true)
  await fs.rm(work, { recursive: true, force: true }).catch(() => {})
}

if (failures.length) {
  console.error("\n[smoke] FAILED:\n- " + failures.join("\n- "))
  if (serverLog.some((line) => /error/i.test(line))) console.error("\n[smoke] server output:\n" + serverLog.join("").slice(-4000))
  process.exit(1)
}
log("all browser tools work under Node, in both modes")

/** Runs one scenario in a session of its own and checks what the tools said. */
async function run(base: string, scenario: Scenario) {
  const project = path.join(work, `project-${scenario.name}`)
  const api = async (method: string, route: string, body?: unknown) => {
    const url = new URL(route, base)
    url.searchParams.set("directory", project)
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${await response.text()}`)
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }
  // As the app's clock does: queue the video, open a session, claim the post, tell the agent.
  const prep = scenario.social === "prep"
  const queued = scenario.social
    ? (
        await api("POST", "/experimental/social", {
          source: socialVideo,
          networks: ["instagram"],
          // A prep runs ten minutes ahead; a post when it is due.
          at: prep ? Date.now() + 5 * 60_000 : Date.now() - 1000,
          ...(prep ? { frames: [STILL], duration: 12, width: 1080, height: 1920 } : {}),
        })
      )[0]
    : undefined
  const session = await api("POST", "/session", {})
  if (queued) {
    const claimed = await api("POST", `/experimental/social/${queued.id}/${prep ? "prepare" : "claim"}`, {
      sessionID: session.id,
    })
    const taken = prep ? claimed?.prep?.status === "running" : claimed?.status === "producing"
    if (!taken) failures.push(`[${scenario.name}] the post was not claimed`)
    Object.assign(social, { id: queued.id, video: queued.video, session: session.id })
  }
  if (scenario.metadata) await api("PATCH", `/session/${session.id}`, { metadata: scenario.metadata })
  await api("POST", `/session/${session.id}/prompt_async`, {
    ...(queued ? { agent: prep ? "social-prep" : "social" } : {}),
    parts: [
      {
        type: "text",
        text: [
          queued && !prep ? `Post agendado — id: ${queued.id}\nRede: Instagram\nVídeo: ${queued.video}\n` : "",
          queued && prep ? `Preparar a legenda (não poste nada) — id: ${queued.id}\nRede: Instagram\n` : "",
          `Faça o roteiro ${scenario.name} de fumaça.`,
        ].join(""),
      },
      // The stills go as the app's clock sends them: files the server reads into the message.
      ...(prep
        ? (queued.frames as string[]).map((frame, index) => ({
            type: "file",
            mime: "image/jpeg",
            filename: `quadro-${index + 1}.jpg`,
            url: pathToFileURL(frame).href,
          }))
        : []),
    ],
  })

  // Done once the fake model's closing text is in.
  type Part = {
    type: string
    tool?: string
    text?: string
    state?: { status: string; output?: string; error?: string; input?: unknown; time?: { start: number; end?: number } }
  }
  const deadline = Date.now() + 300_000
  let seen: Part[] = []
  while (Date.now() < deadline) {
    seen = ((await api("GET", `/session/${session.id}/message`)) as { parts: Part[] }[]).flatMap((message) => message.parts)
    // The stand-in for the user: answers "Pronto" to what the browser asks of them.
    const pending = (await api("GET", "/question")) as { id: string; sessionID: string; questions: { question: string }[] }[]
    for (const request of pending.filter((item) => item.sessionID === session.id)) {
      answered.push(request.questions[0]?.question ?? "")
      await api("POST", `/question/${request.id}/reply`, { answers: [["Pronto"]] })
    }
    const tools = seen.filter((part) => part.type === "tool")
    const settled = tools.every((part) => part.state?.status === "completed" || part.state?.status === "error")
    if (settled && seen.some((part) => part.type === "text" && part.text === "Pronto.")) break
    await Bun.sleep(500)
  }

  const tools = seen.filter((part) => part.type === "tool")
  for (const [index, part] of tools.entries()) {
    const output = part.state?.output ?? part.state?.error ?? ""
    const line = `${part.tool} ${JSON.stringify(part.state?.input)}`
    if (scenario.refused?.includes(index)) {
      if (part.state?.status !== "error") failures.push(`[${scenario.name}] ${line}
    expected a refusal, got ${part.state?.status}`)
      else log("refused as expected", line.slice(0, 100))
    } else if (part.state?.status !== "completed")
      failures.push(`[${scenario.name}] ${line}\n    ${part.state?.status}: ${output.slice(0, 400)}`)
    else log("ok", line.slice(0, 110))
    if (/Bun is not defined|is not a function|Cannot find module/i.test(output))
      failures.push(`[${scenario.name}] ${line}\n    runtime error: ${output.slice(0, 400)}`)
  }
  const expect = (label: string, holds: boolean) => {
    if (!holds) failures.push(`[${scenario.name}] expected: ${label}`)
  }
  expect("every scripted tool ran", tools.length === scenario.steps.length)
  // The picture after each step is taken while the model thinks; by now they are on disk.
  const shots = tools.flatMap((part) => {
    const shot = (part.state as { metadata?: { shot?: unknown } } | undefined)?.metadata?.shot
    return typeof shot === "string" ? [shot] : []
  })
  expect("steps keep a picture of the page", shots.length > 0)
  const pictures = await Promise.all(
    shots.map((shot) => api("GET", `/experimental/browser/trail/${session.id}/${encodeURIComponent(shot)}`)),
  )
  const fetched = pictures.filter((picture) => typeof picture?.image === "string" && picture.image.startsWith("data:image/jpeg"))
  // In the extension run the extension restarts right after one step, taking
  // that step's picture with it; nothing waits on a picture, so that is all it costs.
  const lost = scenario.name === "extension" ? 1 : 0
  expect(`every step's picture can be fetched (${fetched.length} of ${shots.length})`, fetched.length >= shots.length - lost)
  await scenario.check(
    (index) => tools[index]?.state?.output ?? tools[index]?.state?.error ?? "",
    expect,
    (index) => (tools[index]?.state?.time?.end ?? 0) - (tools[index]?.state?.time?.start ?? 0),
    api,
  )
}

/**
 * Stands in for the OpenCode Browser Bridge extension: pairs over the socket
 * the real one uses and answers its requests from a headless Edge through
 * CDP, the way background.js does through chrome.debugger. Like the real one,
 * every command attaches the debugger first if it is not, so after a restart
 * commands go through on a fresh attachment with the page's events off, which
 * is what the server has to notice and fix.
 */
async function startFakeExtension() {
  const executable = BrowserInstall.resolve().executablePath
  if (!executable) throw new Error("no Edge or Chrome found for the extension run")
  const profile = path.join(work, "extension-browser")
  await fs.mkdir(profile, { recursive: true })
  const child = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--edge-skip-compat-layer-relaunch",
      "--headless=new",
      "about:blank",
    ],
    { stdio: "ignore" },
  )
  const portFile = path.join(profile, "DevToolsActivePort")
  const port = await (async () => {
    for (let i = 0; i < 150; i++) {
      const text = await fs.readFile(portFile, "utf8").catch(() => "")
      if (text) return text.split("\n")[0]!.trim()
      await Bun.sleep(100)
    }
    throw new Error("the extension's browser did not start")
  })()
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }
  const cdp = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve) => cdp.addEventListener("open", resolve, { once: true }))

  let next = 1
  const calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  const sessions = new Map<string, string>()
  const targetsOf = new Map<string, string>()
  let socket: WebSocket | undefined
  let base = ""
  let restarts = 0
  let created = 0
  let navigateStarted = 0
  let lastNavigationMs = 0
  let stopped = false

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      const id = next++
      calls.set(id, { resolve, reject })
      cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  cdp.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id) {
      const call = calls.get(message.id)
      calls.delete(message.id)
      if (message.error) call?.reject(new Error(message.error.message))
      else call?.resolve(message.result ?? {})
      return
    }
    const targetId = message.sessionId ? targetsOf.get(message.sessionId) : undefined
    if (!targetId) return
    if (message.method === "Page.loadEventFired" && navigateStarted) {
      lastNavigationMs = Date.now() - navigateStarted
      navigateStarted = 0
    }
    reply({ type: "event", targetId, method: message.method, params: message.params ?? {} })
  })

  const reply = (message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }
  const attached = async (targetId: string) => {
    const known = sessions.get(targetId)
    if (known) return known
    const result = await send("Target.attachToTarget", { targetId, flatten: true })
    sessions.set(targetId, result.sessionId)
    targetsOf.set(result.sessionId, targetId)
    return result.sessionId as string
  }
  const handle = async (message: any) => {
    const ok = (result: unknown) => reply({ id: message.id, type: "result", result: result ?? {} })
    try {
      switch (message.type) {
        case "listTargets": {
          const result = await send("Target.getTargets")
          const pages = result.targetInfos.filter((info: any) => info.type === "page")
          return ok({
            targets: pages.map((info: any, index: number) => ({
              targetId: info.targetId,
              url: info.url,
              title: info.title,
              active: index === 0,
            })),
          })
        }
        case "attach":
          await attached(message.targetId)
          return ok({})
        case "detach": {
          const sessionId = sessions.get(message.targetId)
          sessions.delete(message.targetId)
          if (sessionId) await send("Target.detachFromTarget", { sessionId }).catch(() => {})
          return ok({})
        }
        case "command": {
          // What Brave answers an extension without access to file URLs.
          if (message.method === "DOM.setFileInputFiles") throw new Error("Not allowed")
          const sessionId = await attached(message.targetId)
          if (message.method === "Page.navigate") navigateStarted = Date.now()
          return ok(await send(message.method, message.params ?? {}, sessionId))
        }
        case "createTarget": {
          created++
          const result = await send("Target.createTarget", { url: message.url || "about:blank" })
          return ok({ targetId: result.targetId })
        }
        case "closeTarget":
          await send("Target.closeTarget", { targetId: message.targetId })
          return ok({})
        case "activateTarget":
          await send("Target.activateTarget", { targetId: message.targetId }).catch(() => {})
          return ok({})
        case "goBack": {
          const sessionId = await attached(message.targetId)
          const history = await send("Page.getNavigationHistory", {}, sessionId)
          const entry = history.entries[history.currentIndex - 1]
          if (entry) await send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId)
          return ok({})
        }
        default:
          return reply({ id: message.id, type: "error", error: `Unknown request type ${message.type}` })
      }
    } catch (error) {
      reply({ id: message.id, type: "error", error: error instanceof Error ? error.message : String(error) })
    }
  }
  const connect = () => {
    if (stopped) return
    const ws = new WebSocket(`${base.replace(/^http/, "ws").replace(/\/$/, "")}/experimental/browser/extension`)
    socket = ws
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "auth", token: TOKEN, previous: { reason: restarts ? "worker-start" : "first" } })),
    )
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === "pong") return
      void handle(message)
    })
  }

  return {
    pair(url: string) {
      base = url
      connect()
    },
    /** What the browser does to the extension's worker: the socket goes, and every debugger session with it. */
    restart(awayMs: number) {
      restarts++
      socket?.close()
      socket = undefined
      for (const sessionId of sessions.values()) void send("Target.detachFromTarget", { sessionId }).catch(() => {})
      sessions.clear()
      setTimeout(connect, awayMs)
    },
    restarts: () => restarts,
    created: () => created,
    lastNavigationMs: () => lastNavigationMs,
    stop() {
      stopped = true
      socket?.close()
      cdp.close()
      child.kill()
    },
  }
}
