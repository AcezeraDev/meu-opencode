import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserPage } from "@/browser/page"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_find.txt"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: 'Words the element shows or is named by, such as "próxima página" or "enviar".',
  }),
  role: Schema.optional(Schema.String).annotate({
    description: 'Only elements of this role, such as "button", "link", "radio" or "textbox".',
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "How many elements to list at most (default: 20)." }),
  tab: Schema.optional(Schema.String).annotate({ description: "Tab id to search. Defaults to the active tab." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  url: string
  matches: number
  /** A part of the page, so a later whole outline clears it from the model's context. */
  page?: string
}

export const BrowserFindTool = Tool.define(
  "browser_find",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const tab = params.tab ? yield* browser.select(params.tab) : yield* browser.tab()
          tab.announce("read")
          if (tab.pdf) {
            return {
              output: `The tab shows a PDF (${tab.pdf}), which has nothing to act on. Read it with browser_snapshot.`,
              title: tab.pdf,
              metadata: { url: tab.pdf, matches: 0, page: "part" },
            }
          }
          const url = yield* Effect.promise(() => tab.url())
          yield* ctx.metadata({ title: params.query, metadata: { url, matches: 0 } })
          const result = yield* Effect.promise(() => tab.snapshot())
          const found = BrowserPage.find(result, params.query, { role: params.role, limit: params.limit })
          return {
            output: found.output,
            title: params.query,
            metadata: { url: result.url, matches: found.count, page: "part" },
          }
        }).pipe(BrowserPage.retryDropped, Effect.orDie),
    }
  }),
)
