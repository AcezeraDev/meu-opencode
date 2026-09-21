import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserBlocked } from "@/browser/blocked"
import { BrowserPage } from "@/browser/page"
import { BrowserPdf } from "@/browser/pdf"
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
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  action: string
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

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const action = params.action ?? (params.url ? "goto" : "list_tabs")
          const url = params.url ? normalize(params.url) : undefined

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

          // A PDF has no page to act on, and the person's own browser does not
          // let the extension into its PDF viewer: it is read directly, and the
          // tab stays where it is.
          if ((action === "goto" || action === "new_tab") && url && BrowserPdf.looksLikePdf(url)) {
            const active = yield* browser.current()
            const text = yield* Effect.promise(() => BrowserPage.readPdf(url, active))
            return {
              output: [text, "", "(Read directly; the browser tab was left as it was.)"].join("\n"),
              title: `PDF ${url}`,
              metadata: { action, url, page: "pdf" },
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

          const tab =
            action === "new_tab"
              ? yield* browser.open()
              : action === "select_tab" || (action === "goto" && params.tab)
                ? yield* browser.select(params.tab!)
                : yield* browser.tab()
          const before = tab.pdf

          const waitUntil = params.waitUntil ?? "domcontentloaded"
          const timeout = yield* browser.timeout()

          let refusal: ReturnType<typeof BrowserBlocked.refused>
          if (action === "goto" || action === "new_tab") {
            const failure = yield* Effect.promise(() =>
              tab.navigate(url!, waitUntil, timeout).then(
                () => undefined,
                (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
              ),
            )
            refusal = failure ? BrowserBlocked.refused(failure.message) : undefined
            if (failure && !refusal) throw failure
          } else if (action === "back") {
            yield* Effect.promise(() => tab.history(-1, waitUntil, timeout))
          } else if (action === "forward") {
            yield* Effect.promise(() => tab.history(1, waitUntil, timeout))
          } else if (action === "reload") {
            yield* Effect.promise(() => tab.reload(waitUntil, timeout))
          }
          // A parsed document is often still being built by its scripts; the
          // outline should show what they render, not the empty shell.
          if (NAVIGATIONS.has(action) && waitUntil === "domcontentloaded" && !refusal) {
            yield* Effect.promise(() => tab.quiet(150, 2500))
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

          if (params.snapshot === false) {
            const [current, title] = yield* Effect.promise(() => Promise.all([tab.url(), tab.title()]))
            return {
              output: [`url: ${current}`, `title: ${title || "(untitled)"}`].join("\n"),
              title: title || current,
              metadata: { action, url: current },
            }
          }

          const result = yield* Effect.promise(() => tab.snapshot())
          return {
            output: BrowserPage.outline(tab, result),
            title: result.title || result.url,
            metadata: { action, url: result.url, refs: result.refs, page: "outline" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
