import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserPage } from "@/browser/page"
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
] as const

export const Parameters = Schema.Struct({
  url: Schema.optional(Schema.String).annotate({
    description: "The URL to open. Required for goto and new_tab. https:// is assumed when no scheme is given.",
  }),
  action: Schema.optional(Schema.Literals(ACTIONS)).annotate({
    description: "What to do. Defaults to goto when a url is given, otherwise list_tabs.",
  }),
  tab: Schema.optional(Schema.String).annotate({
    description: "Tab id for select_tab and close_tab, as shown by list_tabs.",
  }),
  waitUntil: Schema.optional(Schema.Literals(["load", "domcontentloaded", "networkidle"])).annotate({
    description:
      "How long to wait for the page. 'load' (default) waits for the load event, 'networkidle' also waits for requests to settle, which helps with single page apps.",
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
}

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
          if (url && !url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("file://")) {
            throw new Error("URL must be http://, https:// or file://")
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

          if (action === "close_browser") {
            yield* browser.shutdown()
            return { output: "Browser closed.", title: "Browser closed", metadata: { action } }
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
              : action === "select_tab"
                ? yield* browser.select(params.tab!)
                : yield* browser.tab()

          const waitUntil = params.waitUntil ?? "load"
          const timeout = yield* browser.timeout()

          if (action === "goto" || action === "new_tab") {
            yield* Effect.promise(() => tab.navigate(url!, waitUntil, timeout))
          } else if (action === "back") {
            yield* Effect.promise(() => tab.history(-1, waitUntil, timeout))
          } else if (action === "forward") {
            yield* Effect.promise(() => tab.history(1, waitUntil, timeout))
          } else if (action === "reload") {
            yield* Effect.promise(() => tab.reload(waitUntil, timeout))
          }

          const current = yield* Effect.promise(() => tab.url())
          const title = yield* Effect.promise(() => tab.title())
          yield* ctx.metadata({ title: title || current, metadata: { action, url: current } })

          if (params.snapshot === false) {
            return {
              output: [`url: ${current}`, `title: ${title || "(untitled)"}`].join("\n"),
              title: title || current,
              metadata: { action, url: current },
            }
          }

          const result = yield* Effect.promise(() => tab.snapshot())
          return {
            output: BrowserPage.render(result),
            title: title || current,
            metadata: { action, url: current, refs: result.refs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
