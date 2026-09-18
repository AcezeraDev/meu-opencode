import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserPage } from "@/browser/page"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_snapshot.txt"

export const Parameters = Schema.Struct({
  format: Schema.optional(Schema.Literals(["outline", "text", "markdown", "html"])).annotate({
    description: "How to read the page. Defaults to outline, which is the only format that produces refs.",
  }),
  maxNodes: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of elements in the outline (default: 1500). Raise it for very large pages.",
  }),
  tab: Schema.optional(Schema.String).annotate({ description: "Tab id to read. Defaults to the active tab." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  format: string
  url: string
  refs?: number
}

export const BrowserSnapshotTool = Tool.define(
  "browser_snapshot",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const tab = params.tab ? yield* browser.select(params.tab) : yield* browser.tab()
          const format = params.format ?? "outline"
          tab.announce("read")
          const url = yield* Effect.promise(() => tab.url())
          yield* ctx.metadata({ title: url, metadata: { format, url } })

          if (format === "text") {
            const result = yield* Effect.promise(() => tab.text())
            return {
              output: [`url: ${result.url}`, `title: ${result.title || "(untitled)"}`, "", result.text.trim()].join(
                "\n",
              ),
              title: result.title || result.url,
              metadata: { format, url: result.url },
            }
          }

          if (format === "html") {
            const result = yield* Effect.promise(() => tab.html())
            return { output: result.html, title: result.title || result.url, metadata: { format, url: result.url } }
          }

          if (format === "markdown") {
            const result = yield* BrowserPage.markdown(tab)
            return {
              output: [`url: ${result.url}`, `title: ${result.title || "(untitled)"}`, "", result.markdown.trim()].join(
                "\n",
              ),
              title: result.title || result.url,
              metadata: { format, url: result.url },
            }
          }

          const result = yield* Effect.promise(() => tab.snapshot({ maxNodes: params.maxNodes }))
          return {
            output: BrowserPage.render(result),
            title: result.title || result.url,
            metadata: { format, url: result.url, refs: result.refs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
