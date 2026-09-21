import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserPage } from "@/browser/page"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_screenshot.txt"

export const Parameters = Schema.Struct({
  ref: Schema.optional(Schema.String).annotate({
    description: "Capture only this element, using a ref from the most recent snapshot.",
  }),
  selector: Schema.optional(Schema.String).annotate({
    description: "Capture only the element matching this CSS selector. Ignored when ref is given.",
  }),
  fullPage: Schema.optional(Schema.Boolean).annotate({
    description: "Capture the whole scrollable page instead of just the viewport.",
  }),
  tab: Schema.optional(Schema.String).annotate({ description: "Tab id to capture. Defaults to the active tab." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  url: string
  bytes: number
  /** Marks the result as a view of the page, which a later outline supersedes in the model's context. */
  page?: string
}

export const BrowserScreenshotTool = Tool.define(
  "browser_screenshot",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const tab = params.tab ? yield* browser.select(params.tab) : yield* browser.tab()
          const url = yield* Effect.promise(() => tab.url())
          tab.announce("screenshot")
          yield* ctx.metadata({ title: url, metadata: { url, bytes: 0 } })

          const selector = BrowserPage.selectorFor(params)
          const buffer = yield* Effect.promise(() => tab.screenshot({ selector, fullPage: params.fullPage }))
          const title = yield* Effect.promise(() => tab.title())
          // Many models cannot see images; the text the picture shows lets
          // them read it anyway, and costs the others little.
          const text = selector
            ? ""
            : yield* Effect.promise(() => tab.visibleText({ fullPage: params.fullPage === true }))

          return {
            output: [
              `Screenshot of ${url} attached.`,
              ...(text ? ["", "Text shown in it, top to bottom (for reading when images cannot be seen):", text] : []),
            ].join("\n"),
            title: title || url,
            metadata: { url, bytes: buffer.byteLength, page: "screenshot" },
            attachments: [
              {
                type: "file" as const,
                mime: "image/jpeg",
                url: `data:image/jpeg;base64,${buffer.toString("base64")}`,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
