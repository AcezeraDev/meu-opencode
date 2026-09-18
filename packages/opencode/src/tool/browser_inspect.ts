import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserPage } from "@/browser/page"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_inspect.txt"

export const Parameters = Schema.Struct({
  what: Schema.Literals(["console", "network", "evaluate"]).annotate({ description: "What to inspect." }),
  expression: Schema.optional(Schema.String).annotate({
    description: "JavaScript to evaluate in page context. Required when what is evaluate.",
  }),
  filter: Schema.optional(Schema.String).annotate({
    description: "Only return console lines or request URLs containing this text.",
  }),
  errorsOnly: Schema.optional(Schema.Boolean).annotate({
    description: "For console, return only errors and warnings. For network, return only failures and 4xx/5xx.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of entries to return, newest last. Defaults to 50.",
  }),
  tab: Schema.optional(Schema.String).annotate({ description: "Tab id to inspect. Defaults to the active tab." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  url: string
  what?: string
  count?: number
}

const ERROR_TYPES = new Set(["error", "warning", "assert", "pageerror"])

export const BrowserInspectTool = Tool.define(
  "browser_inspect",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const tab = params.tab ? yield* browser.select(params.tab) : yield* browser.tab()
          const url = yield* Effect.promise(() => tab.url())
          const limit = params.limit ?? 50
          tab.announce("inspect", params.what)
          yield* ctx.metadata({ title: `${params.what} ${url}`, metadata: { what: params.what, url } })

          if (params.what === "evaluate") {
            if (!params.expression) throw new Error("The evaluate action needs an expression.")

            // Arbitrary JavaScript in a page loaded under the user's own browser
            // profile is the sharpest edge here, so it always asks.
            yield* ctx.ask({
              permission: "browser_evaluate",
              patterns: [url],
              always: [],
              metadata: { url, expression: params.expression },
            })

            const value = yield* Effect.promise(() =>
              tab
                .evaluate<unknown>(`(() => { return (${params.expression}) })()`)
                .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
            )
            const rendered = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value))
            return { output: rendered, title: `evaluate on ${url}`, metadata: { url } }
          }

          const needle = params.filter?.toLowerCase()

          if (params.what === "console") {
            let entries = tab.console
            if (params.errorsOnly) entries = entries.filter((entry) => ERROR_TYPES.has(entry.type))
            if (needle) entries = entries.filter((entry) => entry.text.toLowerCase().includes(needle))
            return {
              output: BrowserPage.renderConsole(entries.slice(-limit)),
              title: `console of ${url}`,
              metadata: { url, count: entries.length },
            }
          }

          let entries = tab.network
          if (params.errorsOnly) {
            entries = entries.filter((entry) => entry.failure !== undefined || (entry.status ?? 0) >= 400)
          }
          if (needle) entries = entries.filter((entry) => entry.url.toLowerCase().includes(needle))
          return {
            output: BrowserPage.renderNetwork(entries.slice(-limit)),
            title: `network of ${url}`,
            metadata: { url, count: entries.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
