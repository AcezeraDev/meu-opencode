import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserPage } from "@/browser/page"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_act.txt"

const ACTIONS = [
  "click",
  "double_click",
  "right_click",
  "hover",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "scroll",
  "wait_for",
] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: "What to do on the page." }),
  ref: Schema.optional(Schema.String).annotate({
    description: "Element ref from the most recent snapshot, such as ref_12. The preferred way to target an element.",
  }),
  selector: Schema.optional(Schema.String).annotate({
    description: "CSS selector, for elements the snapshot did not surface. Ignored when ref is given.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description:
      "Text to fill or type, the key for press, the option for select, or the text to wait for with wait_for.",
  }),
  submit: Schema.optional(Schema.Boolean).annotate({
    description: "Press Enter after fill or type, which submits most forms.",
  }),
  direction: Schema.optional(Schema.Literals(["up", "down", "left", "right"])).annotate({
    description: "Scroll direction. Defaults to down.",
  }),
  amount: Schema.optional(Schema.Number).annotate({ description: "Scroll distance in pixels. Defaults to 600." }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "How long to wait for the element, in seconds. Defaults to the configured browser timeout.",
  }),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description: "Return the page outline after acting. Defaults to true.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  action: string
  url: string
  ref?: string
  refs?: number
}

/** Actions that cannot do anything without knowing which element they mean. */
const NEEDS_TARGET = new Set(["click", "double_click", "right_click", "hover", "fill", "select", "check", "uncheck"])

export const BrowserActTool = Tool.define(
  "browser_act",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const tab = yield* browser.tab()
          const url = yield* Effect.promise(() => tab.url())
          const label = params.ref ?? params.selector ?? params.text ?? params.action

          yield* ctx.metadata({
            title: `${params.action} ${label}`,
            metadata: { action: params.action, url, ref: params.ref },
          })

          // Acting runs under the persistent profile, so it can post, buy or
          // delete as the user. Consent is keyed on the site being acted on.
          yield* ctx.ask({
            permission: "browser",
            patterns: [url],
            always: ["*"],
            metadata: { action: params.action, url, ref: params.ref, selector: params.selector, text: params.text },
          })

          const timeout = params.timeout ? params.timeout * 1000 : yield* browser.timeout()
          const selector = BrowserPage.selectorFor(params)

          if (NEEDS_TARGET.has(params.action) && !selector) {
            throw new Error(`The ${params.action} action needs a ref or a selector.`)
          }
          if (params.action === "wait_for" && !selector && !params.text) {
            throw new Error("The wait_for action needs a ref, a selector or text to wait for.")
          }

          yield* Effect.promise(async () => {
            switch (params.action) {
              case "click":
                await tab.click(selector!)
                break
              case "double_click":
                await tab.click(selector!, "left", 2)
                break
              case "right_click":
                await tab.click(selector!, "right")
                break
              case "hover":
                await tab.hover(selector!)
                break
              case "fill":
                await tab.fill(selector!, params.text ?? "")
                if (params.submit) await tab.press("Enter", selector)
                break
              case "type":
                await tab.type(selector, params.text ?? "")
                if (params.submit) await tab.press("Enter")
                break
              case "press":
                await tab.press(params.text ?? "Enter", selector)
                break
              case "select":
                await tab.select(selector!, params.text ?? "")
                break
              case "check":
                await tab.setChecked(selector!, true)
                break
              case "uncheck":
                await tab.setChecked(selector!, false)
                break
              case "scroll": {
                const amount = params.amount ?? 600
                const direction = params.direction ?? "down"
                const x = direction === "right" ? amount : direction === "left" ? -amount : 0
                const y = direction === "down" ? amount : direction === "up" ? -amount : 0
                await tab.scroll(selector, x, y)
                break
              }
              case "wait_for":
                await tab.waitFor({ selector, text: params.text }, timeout)
                break
            }
          })

          // Most interactions navigate or re-render; letting the page settle
          // keeps the returned outline from describing a page mid-update.
          if (params.action !== "wait_for" && params.action !== "hover") {
            yield* Effect.promise(() => tab.waitForLoad("domcontentloaded", 1500).catch(() => {}))
          }

          const current = yield* Effect.promise(() => tab.url())
          const title = yield* Effect.promise(() => tab.title())
          const done = `${params.action} on ${label} succeeded.`

          if (params.snapshot === false) {
            return {
              output: [done, `url: ${current}`, `title: ${title || "(untitled)"}`].join("\n"),
              title: `${params.action} ${label}`,
              metadata: { action: params.action, url: current },
            }
          }

          const result = yield* Effect.promise(() => tab.snapshot())
          return {
            output: [done, "", BrowserPage.render(result)].join("\n"),
            title: `${params.action} ${label}`,
            metadata: { action: params.action, url: current, refs: result.refs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
