import { Effect, Schema } from "effect"
import { Question } from "@/question"
import { Browser } from "@/browser/session"
import { BrowserBlocked } from "@/browser/blocked"
import { BrowserPage } from "@/browser/page"
import { BrowserTrail } from "@/browser/trail"
import { BrowserPdf } from "@/browser/pdf"
import { BrowserSite } from "@/browser/site"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_navigate.txt"

const ACTIONS = [
  "goto",
  "back",
  "forward",
  "reload",
  "new_tab",
  "select_tab",
  "close_tab",
  "list_tabs",
  "close_browser",
  "ask_user",
  // Last on purpose: strict function calling backends fill an omitted enum
  // with its first value, and this one hands the page away.
  "open_external",
] as const

export const Parameters = Schema.Struct({
  url: Schema.optional(Schema.String).annotate({
    description:
      "The URL to open. Required for goto and new_tab. For open_external it defaults to the current page. https:// is assumed when no scheme is given.",
  }),
  action: Schema.optional(Schema.Literals(ACTIONS)).annotate({
    description: "What to do. Defaults to goto when a url is given, otherwise list_tabs.",
  }),
  tab: Schema.optional(Schema.String).annotate({
    description: "Tab id for select_tab and close_tab, as shown by list_tabs. With goto, the tab to navigate.",
  }),
  waitUntil: Schema.optional(Schema.Literals(["domcontentloaded", "load", "networkidle"])).annotate({
    description:
      "How long to wait for the page. 'domcontentloaded' (default) returns once the document is parsed and has stopped changing, which is enough for most pages and single page apps. 'load' also waits for every image and script, 'networkidle' for requests to stop.",
  }),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description: "Return the page outline after navigating. Defaults to true.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description:
      "For ask_user: what the user should do in the browser, in their language, such as 'entrar na sua conta do Moodle'.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  action: string
  /** How long each part took, in ms, for diagnosing a slow navigation later; the model never sees it. */
  timing?: Record<string, number>
  /** Browser commands that took unusually long during it. */
  slow?: unknown[]
  /** The step whose picture of the page was kept for the trail. */
  shot?: string
  url?: string
  tab?: string
  refs?: number
  /** The browser a page was handed to; empty for the system default. */
  handoff?: string
  /** Why the site was considered to have blocked the built-in browser. */
  blocked?: string
  /** What the result shows of the page, so older views can be left out of the model's context. */
  page?: string
}

const NAVIGATIONS = new Set(["goto", "new_tab", "back", "forward", "reload"])

function normalize(url: string) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url
  return `https://${url}`
}

export const BrowserNavigateTool = Tool.define(
  "browser_navigate",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const action = params.action ?? (params.url ? "goto" : "list_tabs")
          // A path from the outline opens on the site of the page the tab is on.
          const current = params.url?.startsWith("/") ? yield* browser.current() : undefined
          const written = params.url?.startsWith("/")
            ? yield* Effect.promise(() => BrowserPage.resolveAddress(params.url!, current))
            : params.url
          const url = written ? normalize(written) : undefined

          if ((action === "goto" || action === "new_tab") && !url) {
            throw new Error(`The ${action} action needs a url.`)
          }
          if (
            url &&
            url !== "about:blank" &&
            !url.startsWith("http://") &&
            !url.startsWith("https://") &&
            !url.startsWith("file://")
          ) {
            throw new Error("URL must be http://, https://, file:// or about:blank")
          }

          yield* ctx.metadata({ title: url ?? action, metadata: { action, url } })

          // Navigation is where the browser reaches the network under the
          // user's persistent profile, so that is where consent belongs.
          if (action === "goto" || action === "new_tab") {
            yield* ctx.ask({
              permission: "browser",
              patterns: [url!],
              always: ["*"],
              metadata: { action, url },
            })
          }

          if (action === "list_tabs") {
            const status = yield* browser.status()
            return { output: BrowserPage.renderStatus(status), title: "Browser tabs", metadata: { action } }
          }

          if (action === "open_external") {
            // Never starts the browser: with nothing open, the url must say what to open.
            const active = url ? undefined : yield* browser.current()
            const target = url ?? (active ? yield* Effect.promise(() => active.url()) : undefined)
            if (!target || !/^https?:\/\//.test(target)) {
              throw new Error("open_external needs an http(s) url, or an http(s) page open in the browser.")
            }
            yield* ctx.ask({
              permission: "browser",
              patterns: [target],
              always: ["*"],
              metadata: { action, url: target },
            })
            const handoff = yield* browser.handoff(target)
            if (handoff.error) throw new Error(`Could not open ${target} in the user's browser: ${handoff.error}`)
            return {
              output: BrowserPage.renderHandoff({ url: target, handoff }),
              title: `Opened in ${handoff.browser ?? "the default browser"}`,
              metadata: { action, url: target, handoff: handoff.browser ?? "" },
            }
          }

          // The browser's own PDF viewer has no page to act on, and the
          // person's own browser does not let the extension into it: the file
          // is downloaded and read directly, then shown in a viewer of ours.
          if ((action === "goto" || action === "new_tab") && url && BrowserPdf.looksLikePdf(url)) {
            const active = yield* browser.current()
            const opened = yield* Effect.promise(() => BrowserPage.openPdf(url, active))
            const shown =
              "failure" in opened ? undefined : yield* BrowserPage.showPdf(browser, opened, action === "new_tab" ? "new" : "same")
            const output =
              "failure" in opened
                ? opened.failure
                : (shown ??
                  [opened.text, "", `Saved to ${opened.file}. (Read directly; the browser tab was left as it was.)`].join("\n"))
            return { output, title: `PDF ${url}`, metadata: { action, url, page: "pdf" } }
          }

          // A Word, PowerPoint or Excel file is not something a browser shows:
          // it is downloaded and read.
          const office = (action === "goto" || action === "new_tab") && url ? BrowserPage.documentKind(url) : undefined
          if (url && office && office !== "pdf") {
            const active = yield* browser.current()
            const output = yield* Effect.promise(() => BrowserPage.readOffice(url, office, active))
            return { output, title: url, metadata: { action, url, page: "pdf" } }
          }

          // A login, a captcha or a payment is the person's to do: the agent
          // stops and waits for them, and reads the page again when they are done.
          if (action === "ask_user") {
            const reason = params.reason?.trim() || "concluir uma etapa na página aberta"
            const answers = yield* question
              .ask({
                sessionID: ctx.sessionID,
                questions: [
                  {
                    question: `O navegador precisa de você: ${reason}. Faça isso na janela do navegador e depois responda aqui.`,
                    header: "Navegador",
                    options: [
                      { label: "Pronto", description: "Já fiz, a IA pode continuar" },
                      { label: "Pular", description: "Não vou fazer agora" },
                    ],
                    custom: false,
                  },
                ],
                tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
              })
              .pipe(Effect.catch(() => Effect.succeed([["Pular"]])))
            if (answers[0]?.[0] !== "Pronto") {
              return {
                output:
                  "The user did not do it now. Do not try it yourself; carry on with what does not need it, or tell the user what is left.",
                title: "Skipped by the user",
                metadata: { action },
              }
            }
            const tab = yield* browser.tab()
            const result = yield* Effect.promise(() => tab.quiet(150, 2500).then(() => tab.snapshot()))
            return {
              output: ["The user says it is done. The page now:", "", BrowserPage.outline(tab, result)].join("\n"),
              title: "Done by the user",
              metadata: { action, url: result.url, refs: result.refs, page: "outline" },
            }
          }

          if (action === "close_browser") {
            const mode = yield* browser.mode()
            yield* browser.shutdown()
            return {
              output:
                mode === "extension"
                  ? "Stopped driving the user's browser; their tabs stay open. The next browser action attaches again."
                  : "Browser closed.",
              title: "Browser closed",
              metadata: { action },
            }
          }

          if (action === "close_tab") {
            const status = yield* browser.status()
            const id = params.tab ?? status.tabs.find((item) => item.active)?.id
            if (!id) throw new Error("No tab to close.")
            yield* browser.close(id)
            const after = yield* browser.status()
            return { output: BrowserPage.renderStatus(after), title: `Closed ${id}`, metadata: { action, tab: id } }
          }

          if (action === "select_tab" && !params.tab) throw new Error("The select_tab action needs a tab id.")

          const go = Effect.gen(function* () {
            const started = Date.now()
            const tab =
              action === "new_tab"
                ? yield* browser.open()
                : action === "select_tab" || (action === "goto" && params.tab)
                  ? yield* browser.select(params.tab!)
                  : yield* browser.tab()
            const before = tab.pdf
            const got = Date.now()
            // Only this navigation's slow commands are worth reporting with it.
            tab.takeSlow()
            const waitUntil = params.waitUntil ?? "domcontentloaded"
            const timeout = yield* browser.timeout()

            // In the same queue as clicks and typing: a model that sends a
            // navigation and a click together would otherwise have the click land
            // on whichever page happened to be there, with a ref from the other.
            const moving = yield* Effect.promise(() =>
              tab.serialize(async () => {
                if (action === "goto" || action === "new_tab") {
                  const failure = await tab.navigate(url!, waitUntil, timeout).then(
                    () => undefined,
                    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
                  )
                  const refused = failure ? BrowserBlocked.refused(failure.message) : undefined
                  if (failure && !refused) return { failure }
                  if (refused) return { refusal: refused }
                }
                if (action === "back") await tab.history(-1, waitUntil, timeout)
                if (action === "forward") await tab.history(1, waitUntil, timeout)
                if (action === "reload") await tab.reload(waitUntil, timeout)
                const loaded = Date.now()
                // A parsed document is often still being built by its scripts; the
                // outline should show what they render, not the empty shell.
                if (NAVIGATIONS.has(action) && waitUntil === "domcontentloaded") await tab.quiet(150, 2500)
                return { loaded }
              }),
            )
            // An address served as a download ends the navigation without a page:
            // that is not a failure, the file is read below.
            if ("failure" in moving && tab.downloadsSince(started).length === 0) throw moving.failure
            const loaded = ("loaded" in moving && moving.loaded) || Date.now()
            return {
              tab,
              before,
              refusal: "refusal" in moving ? moving.refusal : undefined,
              timing: { tab: got - started, load: loaded - got, settle: Date.now() - loaded },
              started,
            }
          })
          // The extension dropping out mid-navigation (its worker restarted, or
          // the browser stalled until it closed the socket) cost the agent a
          // whole step and usually a second try of its own. Opening the same
          // address again is safe, so it is retried once here: getting the tab
          // again waits for the extension to come back and re-attaches. A click
          // is never retried like this, since it could land twice.
          const moved = yield* go.pipe(
            Effect.catchCause((cause) =>
              (action === "goto" || action === "reload") && BrowserPage.dropped(cause)
                ? go
                : Effect.failCause(cause),
            ),
          )
          const tab = moved.tab
          const before = moved.before
          const refusal = moved.refusal

          // An address that did not look like one can still be a file to download.
          if (action === "goto" || action === "new_tab") {
            const downloaded = yield* BrowserPage.readDownload(browser, tab, moved.started)
            if (downloaded) return { output: downloaded.output, title: downloaded.url, metadata: { action, url: downloaded.url, page: "pdf" } }
          }

          // An address that did not look like one can still serve a PDF.
          if (NAVIGATIONS.has(action)) {
            const pdf = yield* BrowserPage.landedOnPdf(browser, tab, before)
            if (pdf) {
              return { output: pdf.output, title: `PDF ${pdf.url}`, metadata: { action, url: pdf.url, page: "pdf" } }
            }
          }

          // A bot wall is not worth an outline: the page goes to the user's own
          // browser, and the model is told to leave the site to them.
          if (NAVIGATIONS.has(action)) {
            const requested = action === "goto" || action === "new_tab" ? url : undefined
            const handed = yield* BrowserPage.handOver(browser, tab, requested, refusal)
            if (handed) {
              const { handoff } = handed
              return {
                output: handed.output,
                title: handoff.error
                  ? `Blocked: ${handed.block.reason}`
                  : `Opened in ${handoff.browser ?? "the default browser"}`,
                metadata: {
                  action,
                  url: handed.url,
                  blocked: handed.block.reason,
                  ...(handoff.error ? {} : { handoff: handoff.browser ?? "" }),
                },
              }
            }
          }

          const cookies =
            NAVIGATIONS.has(action) && (yield* browser.rejectsCookies())
              ? yield* Effect.promise(() => BrowserPage.refuseCookies(tab))
              : undefined
          const person = NAVIGATIONS.has(action) ? yield* Effect.promise(() => BrowserPage.personNeeded(tab)) : undefined

          if (params.snapshot === false) {
            const [current, title] = yield* Effect.promise(() => Promise.all([tab.url(), tab.title()]))
            const step =
              action === "goto" || action === "new_tab" ? BrowserSite.describeOpen(current) : { text: action }
            const extra = yield* Effect.promise(() =>
              BrowserSite.aside(ctx.sessionID, { steps: [step], from: current, to: current }),
            )
            return {
              output: [
                `url: ${current}`,
                `title: ${title || "(untitled)"}`,
                ...(cookies ? [cookies] : []),
                ...(person ? [person] : []),
                ...extra,
              ].join("\n"),
              title: title || current,
              metadata: { action, url: current },
            }
          }

          const read = Date.now()
          const result = yield* Effect.promise(() => tab.snapshot())
          const arrived = BrowserPage.landed(tab, result)
          const slow = tab.takeSlow()
          BrowserTrail.capture(tab, ctx.sessionID, ctx.callID)
          const step =
            action === "goto" || action === "new_tab" ? BrowserSite.describeOpen(result.url) : { text: action }
          const extra = yield* Effect.promise(() =>
            BrowserSite.aside(ctx.sessionID, { steps: [step], from: result.url, to: result.url }),
          )
          return {
            output: [...(cookies ? [cookies, ""] : []), arrived.output, ...(person ? ["", person] : []), ...extra].join("\n"),
            title: result.title || result.url,
            metadata: {
              action,
              url: result.url,
              refs: result.refs,
              page: "outline",
              ...(arrived.partial ? { partial: true } : {}),
              timing: { ...moved.timing, snapshot: Date.now() - read, total: Date.now() - moved.started },
              ...(ctx.callID ? { shot: ctx.callID } : {}),
              ...(slow.length ? { slow } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
