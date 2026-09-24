import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserSite } from "@/browser/site"
import { BrowserPage } from "@/browser/page"
import { BrowserTrail } from "@/browser/trail"
import type { SnapshotResult } from "@/browser/snapshot"
import type { Tab } from "@/browser/tab"
import { ActionVerifier, type Verdict } from "@/browser/verify"
import { Step } from "./browser_act"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_batch.txt"

/** Enough for any form; a longer list is a plan that should look at the page on the way. */
const MAX_STEPS = 20

/** Judges one batch step before a later step can overwrite its outline signal. */
export function withStepOutline(verdict: Verdict, previous: SnapshotResult | undefined, next: SnapshotResult) {
  return ActionVerifier.withOutline(verdict, previous?.outline !== next.outline)
}

export const Parameters = Schema.Struct({
  steps: Schema.Array(Step).annotate({
    description: `The actions to run, in order, like browser_act's parameters. At most ${MAX_STEPS}.`,
  }),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description: "Report what changed on the page after the last step. Defaults to true.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  url: string
  steps: number
  done: number
  refs?: number
  /** The browser a page was handed to; empty for the system default. */
  handoff?: string
  /** Why the site was considered to have blocked the built-in browser. */
  blocked?: string
  /** What the result shows of the page, so older views can be left out of the model's context. */
  page?: string
  /** What the last step that ran was seen to do. */
  outcome?: string
  /** The step whose picture of the page was kept for the trail. */
  shot?: string
}

export const BrowserBatchTool = Tool.define(
  "browser_batch",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const steps = params.steps
          if (steps.length === 0) throw new Error("browser_batch needs at least one step.")
          if (steps.length > MAX_STEPS) {
            throw new Error(`browser_batch takes at most ${MAX_STEPS} steps; split the work or act on what you see.`)
          }

          const tab = yield* browser.tab()
          const timeout = yield* browser.timeout()
          const title = `${steps.length} browser steps`
          yield* ctx.metadata({ title, metadata: { url: "", steps: steps.length, done: 0 } })

          // Only this batch's slow commands are worth reporting with it.
          tab.takeSlow()
          const began = Date.now()
          let done = 0
          let failure: Error | undefined
          let pdf: { url: string; output: string } | undefined
          let previous = tab.baseline
          let latest: Awaited<ReturnType<typeof tab.snapshot>> | undefined
          /** Where a step took the tab, when the steps after it still aim at refs of the page before. */
          let moved: string | undefined
          /** A tab a step opened, which the browser switched to; the batch ends there. */
          let opened: Tab | undefined
          /** What each step that ran was seen to do, so the report says more than "done". */
          const verdicts: Verdict[] = []
          /** Each step in words that outlive its refs, for noticing a routine. */
          const described: BrowserSite.TrailStep[] = []
          const from = yield* Effect.promise(() => tab.url())
          for (const step of steps) {
            const url = yield* Effect.promise(() => tab.url())
            described.push(BrowserSite.describeStep(step, step.ref ? tab.identityOf(step.ref) : undefined))
            // The same consent as browser_act, per step, since a step can land
            // on another site.
            yield* ctx.ask({
              permission: "browser",
              patterns: [url],
              always: ["*"],
              metadata: { action: step.action, url, ref: step.ref, selector: step.selector, text: step.text },
            })
            const before = tab.pdf
            const started = Date.now()
            const outcome = yield* Effect.promise(() =>
              tab
                .serialize(() => BrowserPage.perform(tab, step, timeout))
                .then(
                  (verdict: Verdict) => ({ verdict }),
                  (error: unknown) => ({ failure: error instanceof Error ? error : new Error(String(error)) }),
                ),
            )
            failure = "failure" in outcome ? outcome.failure : undefined
            // A step that opened a PDF ends the batch: the page the next steps
            // were meant for is gone, and the PDF is read instead.
            pdf =
              (yield* BrowserPage.landedOnPdf(browser, tab, before)) ??
              ("verdict" in outcome ? yield* BrowserPage.readDownload(browser, tab, started) : undefined)
            if (pdf) {
              if ("verdict" in outcome) verdicts.push(outcome.verdict)
              failure = undefined
              done++
              break
            }
            if ("failure" in outcome) break
            opened = yield* BrowserPage.openedTab(browser, tab, started, outcome.verdict)
            if (opened) {
              verdicts.push({ ...outcome.verdict, outcome: "navigation", signals: ["it opened a new tab"] })
              done++
              break
            }
            latest = yield* Effect.promise(() => tab.snapshot())
            verdicts.push(withStepOutline(outcome.verdict, previous, latest))
            previous = latest
            done++
            yield* ctx.metadata({ title, metadata: { url, steps: steps.length, done } })
            // Refs belong to the page they were read on. After a step opens
            // another page, the ones left in the batch can only miss, and each
            // miss used to be looked for again before failing.
            if (outcome.verdict.outcome === "navigation" && steps.slice(done).some((next) => next.ref)) {
              moved = latest.url
              break
            }
          }

          const report = steps.map((step, index) => {
            const label = `${index + 1}. ${BrowserPage.describe(step)}`
            if (index >= done) return `${label}: ${index === done && failure ? "failed" : "not run"}`
            const verdict = verdicts[index]
            return `${label}: done${verdict ? ` (${verdict.outcome}${verdict.signals.length ? `: ${verdict.signals.join("; ")}` : ""})` : ""}`
          })
          const summary = failure
            ? [`Stopped at step ${done + 1} of ${steps.length}: ${failure.message}`, ...report]
            : pdf && done < steps.length
              ? [`Stopped after step ${done} of ${steps.length}: it opened a document, which is read below.`, ...report]
              : opened
                ? [
                    `Stopped after step ${done} of ${steps.length}: it opened a new tab, and the browser switched to it. Continue there with the refs below.`,
                    ...report,
                  ]
                : moved
                  ? [
                      `Stopped after step ${done} of ${steps.length}: it opened another page (${moved}), and the next steps use refs from the page before, which do not carry over. Continue with the refs below.`,
                      ...report,
                    ]
                  : [`Ran all ${steps.length} steps.`, ...report]

          if (pdf) {
            return {
              output: [...summary, "", pdf.output].join("\n"),
              title,
              metadata: { url: pdf.url, steps: steps.length, done, page: "pdf" },
            }
          }

          if (opened) {
            const tab = opened
            const page = yield* Effect.promise(() => tab.snapshot())
            return {
              output: [...summary, "", BrowserPage.outline(tab, page)].join("\n"),
              title,
              metadata: {
                url: page.url,
                steps: steps.length,
                done,
                refs: page.refs,
                page: "outline",
                outcome: "navigation",
              },
            }
          }

          // One check at the end: any step could have landed on a captcha.
          const handed = yield* BrowserPage.handOver(browser, tab)
          if (handed) {
            const { handoff } = handed
            return {
              output: [...summary, "", handed.output].join("\n"),
              title,
              metadata: {
                url: handed.url,
                steps: steps.length,
                done,
                blocked: handed.block.reason,
                ...(handoff.error ? {} : { handoff: handoff.browser ?? "" }),
              },
            }
          }

          if (params.snapshot === false) {
            const [current, page] = yield* Effect.promise(() => Promise.all([tab.url(), tab.title()]))
            return {
              output: [...summary, "", `url: ${current}`, `title: ${page || "(untitled)"}`].join("\n"),
              title,
              metadata: { url: current, steps: steps.length, done },
            }
          }

          const result = latest && !failure ? latest : yield* Effect.promise(() => tab.snapshot())
          const change = BrowserPage.changes(tab, result)
          const last = verdicts[verdicts.length - 1]
          const slow = tab.takeSlow()
          const extra = yield* Effect.promise(() =>
            BrowserSite.aside(ctx.sessionID, { steps: described.slice(0, done), from, to: result.url }),
          )
          BrowserTrail.capture(tab, ctx.sessionID, ctx.callID)
          return {
            output: [...summary, "", change.output, ...extra].join("\n"),
            title,
            metadata: {
              url: result.url,
              steps: steps.length,
              done,
              refs: result.refs,
              page: change.full ? "outline" : "change",
              ...(change.partial ? { partial: true } : {}),
              outcome: last?.outcome,
              // For diagnosing a slow batch later; the model never sees these.
              timing: { total: Date.now() - began },
              ...(slow.length ? { slow } : {}),
              ...(ctx.callID ? { shot: ctx.callID } : {}),
            },
          }
        }).pipe(BrowserPage.explainDropped, Effect.orDie),
    }
  }),
)
