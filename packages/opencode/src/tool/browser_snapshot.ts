import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserPage } from "@/browser/page"
import { BrowserPdf } from "@/browser/pdf"
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
  /** What the result shows of the page, so older views can be left out of the model's context. */
  page?: string
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

          // A PDF has no DOM worth reading: its text is, whatever the format.
          const pdf = tab.pdf
          if (pdf) {
            const text = yield* Effect.promise(() => BrowserPage.readPdf(pdf, tab))
            return { output: text, title: `PDF ${pdf}`, metadata: { format: "pdf", url: pdf, page: "pdf" } }
          }
          const url = yield* Effect.promise(() => tab.url())
          yield* ctx.metadata({ title: url, metadata: { format, url } })

          // The viewer of a downloaded PDF draws pages, which read as nothing
          // but headings; the file's text is what there is to read.
          const viewed = yield* Effect.promise(() => BrowserPdf.readViewed(url).catch(() => undefined))
          if (viewed) {
            return {
              output: [viewed, "", "The tab shows this PDF page by page; take a browser_screenshot to see figures or pages without text."].join("\n"),
              title: `PDF ${url}`,
              metadata: { format: "pdf", url, page: "pdf" },
            }
          }

          if (format === "text") {
            const result = yield* Effect.promise(() => tab.text())
            return {
              output: [`url: ${result.url}`, `title: ${result.title || "(untitled)"}`, "", result.text.trim()].join(
                "\n",
              ),
              title: result.title || result.url,
              metadata: { format, url: result.url, page: "text" },
            }
          }

          if (format === "html") {
            const result = yield* Effect.promise(() => tab.html())
            return {
              output: result.html,
              title: result.title || result.url,
              metadata: { format, url: result.url, page: "text" },
            }
          }

          if (format === "markdown") {
            const result = yield* BrowserPage.markdown(tab)
            return {
              output: [`url: ${result.url}`, `title: ${result.title || "(untitled)"}`, "", result.markdown.trim()].join(
                "\n",
              ),
              title: result.title || result.url,
              metadata: { format, url: result.url, page: "text" },
            }
          }

          const result = yield* Effect.promise(() => tab.snapshot({ maxNodes: params.maxNodes }))
          return {
            output: BrowserPage.outline(tab, result),
            title: result.title || result.url,
            metadata: { format, url: result.url, refs: result.refs, page: "outline" },
          }
        }).pipe(BrowserPage.retryDropped, Effect.orDie),
    }
  }),
)
