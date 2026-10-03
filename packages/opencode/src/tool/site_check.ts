import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserQA } from "@/browser/qa"
import * as Tool from "./tool"
import DESCRIPTION from "./site_check.txt"

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "Address of the site, usually the local dev server (http://localhost:5173)." }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Other routes to check, such as /contato or /painel.",
  }),
  crawl: Schema.optional(Schema.Number).annotate({
    description: "How many links of the first page to follow (default 4, at most 10).",
  }),
  viewports: Schema.optional(Schema.Array(Schema.Literals(["desktop", "tablet", "mobile"]))).annotate({
    description: "Sizes to check (default: all three).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  run?: string
  errors: number
  warnings: number
  pages: number
  previous?: { errors: number; warnings: number }
}

export const SiteCheckTool = Tool.define(
  "site_check",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const url = /^https?:\/\//.test(params.url) ? params.url : `http://${params.url}`
          yield* ctx.ask({ permission: "browser", patterns: [url], always: ["*"], metadata: { action: "site_check", url } })
          yield* ctx.metadata({ title: url, metadata: { errors: 0, warnings: 0, pages: 0 } })
          // A tab of its own, so the check never takes over the page the person is on.
          const tab = yield* browser.open()
          const timeout = yield* browser.timeout()
          const report = yield* Effect.promise(() =>
            BrowserQA.run({
              tab,
              url,
              extra: params.paths ? [...params.paths] : [],
              crawl: Math.max(0, Math.min(10, params.crawl ?? 4)),
              viewports: params.viewports ? [...params.viewports] : undefined,
              navigate: (page) => tab.serialize(() => tab.navigate(page, "load", timeout)).then(() => {}),
            }),
          )
          const errors = report.issues.filter((issue) => issue.severity === "error").length
          const warnings = report.issues.length - errors
          return {
            output: BrowserQA.render(report),
            title: `${url}: ${errors} erro(s), ${warnings} aviso(s)`,
            metadata: {
              run: report.id,
              errors,
              warnings,
              pages: report.pages.length,
              previous: report.previous ? { errors: report.previous.errors, warnings: report.previous.warnings } : undefined,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
