import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserPage } from "@/browser/page"
import { ActionVerifier, type Verdict } from "@/browser/verify"
import { BrowserTab } from "@/browser/tab"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_act.txt"

/** One page action. browser_batch takes a list of these. */
export const Step = Schema.Struct({
  action: Schema.Literals(BrowserPage.ACTIONS).annotate({ description: "What to do on the page." }),
  ref: Schema.optional(Schema.String).annotate({
    description: "Element ref from a snapshot, such as ref_12. The preferred way to target an element.",
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
  direction: Schema.optional(Schema.Literals(["down", "up", "left", "right"])).annotate({
    description: "Scroll direction. Defaults to down.",
  }),
  amount: Schema.optional(Schema.Number).annotate({ description: "Scroll distance in pixels. Defaults to 600." }),
  modifiers: Schema.optional(Schema.Array(Schema.Literals(BrowserTab.MODIFIER_KEYS))).annotate({
    description: "Keys held while clicking, such as Control or Shift, for a control-click or a range selection.",
  }),
  to_ref: Schema.optional(Schema.String).annotate({ description: "Where a drag ends: a ref from a snapshot." }),
  to_selector: Schema.optional(Schema.String).annotate({
    description: "Where a drag ends, as a CSS selector. Ignored when to_ref is given.",
  }),
  file: Schema.optional(Schema.String).annotate({
    description: "Absolute path of the file to attach, for upload_file.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "How long to wait for the element, in seconds. Defaults to the configured browser timeout.",
  }),
})

export const Parameters = Schema.Struct({
  ...Step.fields,
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description: "Report what changed on the page after acting. Defaults to true.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  action: string
  url: string
  ref?: string
  refs?: number
  /** The browser a page was handed to; empty for the system default. */
  handoff?: string
  /** Why the site was considered to have blocked the built-in browser. */
  blocked?: string
  /** What the result shows of the page, so older views can be left out of the model's context. */
  page?: string
  /** What the action was seen to do: confirmed, no visible change, navigation, and so on. */
  outcome?: string
}

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
          const label = BrowserPage.describe(params)

          yield* ctx.metadata({ title: label, metadata: { action: params.action, url, ref: params.ref } })

          // Acting runs under the persistent profile, so it can post, buy or
          // delete as the user. Consent is keyed on the site being acted on.
          yield* ctx.ask({
            permission: "browser",
            patterns: [url],
            always: ["*"],
            metadata: {
              action: params.action,
              url,
              ref: params.ref,
              selector: params.selector,
              text: params.text,
              // Attaching a file sends it to the site, so the ask names it.
              file: params.file,
            },
          })

          const timeout = yield* browser.timeout()
          const before = tab.pdf
          const outcome = yield* Effect.promise(() =>
            BrowserPage.perform(tab, params, timeout).then(
              (verdict: Verdict) => ({ verdict }),
              (error: unknown) => ({ failure: error instanceof Error ? error : new Error(String(error)) }),
            ),
          )
          const failure = "failure" in outcome ? outcome.failure : undefined
          const verdict = "verdict" in outcome ? outcome.verdict : undefined
          const done = verdict ? ActionVerifier.render(label, verdict) : `${label} ran.`

          // A link can lead to a PDF, which has no page to read or act on: its
          // text is read directly and the tab goes back where it was.
          const pdf = yield* BrowserPage.landedOnPdf(browser, tab, before)
          if (pdf) {
            return {
              output: [done, "", pdf.output].join("\n"),
              title: label,
              metadata: { action: params.action, url: pdf.url, page: "pdf" },
            }
          }
          if (failure) throw failure

          // A click or a search can land on a captcha as easily as a link can.
          const handed = yield* BrowserPage.handOver(browser, tab)
          if (handed) {
            const { handoff } = handed
            return {
              output: [done, "", handed.output].join("\n"),
              title: label,
              metadata: {
                action: params.action,
                url: handed.url,
                blocked: handed.block.reason,
                ...(handoff.error ? {} : { handoff: handoff.browser ?? "" }),
              },
            }
          }

          if (params.snapshot === false) {
            const [current, title] = yield* Effect.promise(() => Promise.all([tab.url(), tab.title()]))
            return {
              output: [done, `url: ${current}`, `title: ${title || "(untitled)"}`].join("\n"),
              title: label,
              metadata: { action: params.action, url: current, outcome: verdict?.outcome },
            }
          }

          const result = yield* Effect.promise(() => tab.snapshot())
          const change = BrowserPage.changes(tab, result)
          // The outline is the broadest sign there is, and only the tool holds
          // it: an action that looked like it did nothing may well have.
          const told = verdict ? ActionVerifier.withOutline(verdict, change.changed) : undefined
          return {
            output: [told ? ActionVerifier.render(label, told) : done, "", change.output].join("\n"),
            title: label,
            metadata: {
              action: params.action,
              url: result.url,
              refs: result.refs,
              page: change.full ? "outline" : "change",
              outcome: told?.outcome,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
