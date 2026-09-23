import fs from "fs/promises"
import { readdirSync } from "fs"
import path from "path"
import { Cause, Effect, Schema } from "effect"
import type { CodeMode } from "@opencode-ai/codemode"
import { Global } from "@opencode-ai/core/global"
import { Browser } from "@/browser/session"
import { BrowserPage } from "@/browser/page"
import { BrowserSite } from "@/browser/site"
import type { Tab } from "@/browser/tab"
import { Step } from "./browser_act"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_script.txt"

/**
 * Programs over the browser, run in CodeMode's confined interpreter.
 *
 * Driving a page one tool call at a time sends the model a round trip per
 * click, which is most of the time spent on a long list or a paginated table.
 * A program can loop and decide on its own. It runs in the interpreter rather
 * than in this process, so it has exactly the authority of the browser tools
 * and nothing else: no files, no network, no process.
 */

export const Parameters = Schema.Struct({
  code: Schema.optional(Schema.String).annotate({
    description: "The program. Omit it to run the saved program called `name`.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description:
      "With code: save the program under this name, for the site it started on, once it runs without error. Without code: run the saved program.",
  }),
  description: Schema.optional(Schema.String).annotate({
    description:
      "When saving: what the program does and which args it takes, in a sentence or two. It is shown with the program the next time you are on the site.",
  }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Values the program reads as `args`.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Longest the program may run, in seconds. Defaults to 120, at most 600.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  url?: string
  calls: number
  saved?: string
}

/** Saved programs are the person's, not a project's: the same site is used from any project. */
const SCRIPTS = path.join(Global.Path.data, "browser-scripts")
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const TIMEOUT = 120
const TIMEOUT_MAX = 600
/** A page's outline returned whole a few times is already a lot of context. */
const OUTPUT_MAX = 60_000
const WAIT_MAX = 10_000

/** What each page function takes. */
const SPEC = {
  snapshot: {
    description: "Read the active page: its outline as text, and its elements with their refs.",
    input: Schema.Struct({}),
  },
  act: { description: "Act on the active page, with the same fields as a browser_act step.", input: Step },
  navigate: {
    description: "Open a url in the active tab, or go back, forward or reload.",
    input: Schema.Struct({
      url: Schema.optional(Schema.String),
      action: Schema.optional(Schema.Literals(["goto", "back", "forward", "reload"])),
    }),
  },
  find: {
    description:
      "Find an element on the active page by its accessible name, or by a regular expression over it (and role), returning { ref, role, name, href } or null.",
    input: Schema.Struct({
      name: Schema.optional(Schema.String),
      pattern: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      exact: Schema.optional(Schema.Boolean),
      last: Schema.optional(Schema.Boolean),
    }),
  },
  text: { description: "The visible text of the active page.", input: Schema.Struct({}) },
  wait: {
    description: `Pause, for a page that updates on its own. At most ${WAIT_MAX} ms.`,
    input: Schema.Struct({ ms: Schema.Number }),
  },
  evaluate: {
    description: "Run a JavaScript expression in the active page and return its value. Asks the user first.",
    input: Schema.Struct({ expression: Schema.String }),
  },
}

export const BrowserScriptTool = Tool.define(
  "browser_script",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      // CodeMode's own generated guide would repeat every browser_act field and
      // cost ~7k characters on every request; the description covers the page
      // functions, and the step fields are browser_act's. The programs saved
      // for a site are shown when the agent lands there (see BrowserSite).
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          if (params.name !== undefined && !NAME.test(params.name)) {
            throw new Error("A program name takes letters, digits, - and _, up to 64 of them.")
          }

          const first = yield* browser.tab()
          const start = yield* Effect.promise(() => first.url())
          const host = BrowserSite.hostOf(start)
          const code = params.code ?? (yield* Effect.promise(() => load(host, params.name)))
          yield* ctx.metadata({ title: params.name ?? "browser script", metadata: { url: start, calls: 0 } })
          // Consent as for browser_act: acting under the persistent profile.
          yield* ctx.ask({
            permission: "browser",
            patterns: [start],
            always: ["*"],
            metadata: { action: "script", url: start, code },
          })

          const timeout = yield* browser.timeout()
          // Loaded on first use: the interpreter brings the TypeScript compiler
          // with it, far too heavy to load with the server for a rare tool.
          const codemode = yield* Effect.promise(() => import("@opencode-ai/codemode"))
          /**
           * A browser failure becomes a message the program can catch and the
           * model can read; an interruption (cancelled, timed out) stays one.
           */
          const guard = <A>(effect: Effect.Effect<A>) =>
            effect.pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                const error = Cause.squash(cause)
                return Effect.fail(codemode.toolError(error instanceof Error ? error.message : String(error), error))
              }),
            )
          /** Sites where running JavaScript in the page was already allowed in this run. */
          const evaluating = new Set<string>()
          let calls = 0

          /** Each call acts on whatever tab is active now, so a tab a link opened is followed. */
          const active = () => browser.tab()
          const tools = {
            page: {
              snapshot: codemode.Tool.make({
                ...SPEC.snapshot,
                run: () =>
                  guard(
                    Effect.gen(function* () {
                      const tab = yield* active()
                      const result = yield* Effect.promise(() => tab.snapshot())
                      return {
                        url: result.url,
                        title: result.title,
                        outline: BrowserPage.outline(tab, result),
                        elements: Object.entries(result.identities ?? {}).map(([ref, identity]) => ({
                          ref,
                          role: identity.role,
                          name: identity.name,
                          href: identity.href || undefined,
                        })),
                      }
                    }),
                  ),
              }),
              act: codemode.Tool.make({
                ...SPEC.act,
                run: (step) =>
                  guard(
                    Effect.gen(function* () {
                      const tab = yield* active()
                      const started = Date.now()
                      const verdict = yield* Effect.promise(() =>
                        tab.serialize(() => BrowserPage.perform(tab, step, timeout)),
                      )
                      const opened = yield* BrowserPage.openedTab(browser, tab, started, verdict)
                      const now = opened ?? tab
                      return {
                        outcome: verdict.outcome,
                        signals: verdict.signals,
                        url: yield* Effect.promise(() => now.url()),
                        openedTab: opened ? yield* Effect.promise(() => opened.url()) : undefined,
                      }
                    }),
                  ),
              }),
              navigate: codemode.Tool.make({
                ...SPEC.navigate,
                run: (input) =>
                  guard(
                    Effect.gen(function* () {
                      const action = input.action ?? "goto"
                      if (action === "goto" && !input.url) throw new Error("goto needs a url.")
                      if (action === "goto" && !/^(https?|file):\/\/|^about:blank$/.test(input.url!)) {
                        throw new Error("The url must start with http://, https:// or file://.")
                      }
                      if (action === "goto") {
                        yield* ctx.ask({
                          permission: "browser",
                          patterns: [input.url!],
                          always: ["*"],
                          metadata: { action, url: input.url },
                        })
                      }
                      const tab = yield* active()
                      yield* Effect.promise(() =>
                        tab.serialize(async () => {
                          if (action === "goto") await tab.navigate(input.url!, "domcontentloaded", timeout)
                          if (action === "back") await tab.history(-1, "domcontentloaded", timeout)
                          if (action === "forward") await tab.history(1, "domcontentloaded", timeout)
                          if (action === "reload") await tab.reload("domcontentloaded", timeout)
                          await tab.quiet(150, 2500)
                        }),
                      )
                      return yield* Effect.promise(() => where(tab))
                    }),
                  ),
              }),
              find: codemode.Tool.make({
                ...SPEC.find,
                run: (input) =>
                  guard(
                    Effect.gen(function* () {
                      if (!input.name && !input.pattern) throw new Error("find needs a name or a pattern.")
                      const tab = yield* active()
                      const result = yield* Effect.promise(() => tab.snapshot())
                      const wanted = (input.name ?? "").trim().toLowerCase()
                      const pattern = input.pattern ? new RegExp(input.pattern, "i") : undefined
                      const elements = Object.entries(result.identities ?? {})
                        .map(([ref, identity]) => ({
                          ref,
                          role: identity.role,
                          name: identity.name,
                          href: identity.href || undefined,
                        }))
                        .filter((element) => !input.role || element.role === input.role)
                      // Refs are handed out in order, so the last match is the one that
                      // appeared last, such as a dialog's button named like the one that opened it.
                      const pick = (test: (element: (typeof elements)[number]) => boolean) =>
                        (input.last ? elements.findLast(test) : elements.find(test)) ?? null
                      if (pattern) return pick((element) => pattern.test(element.name))
                      // An exact name first; then, unless told otherwise, one that contains it.
                      const exact = pick((element) => element.name.trim().toLowerCase() === wanted)
                      if (exact || input.exact) return exact
                      return pick((element) => element.name.toLowerCase().includes(wanted))
                    }),
                  ),
              }),
              text: codemode.Tool.make({
                ...SPEC.text,
                run: () => guard(Effect.flatMap(active(), (tab) => Effect.promise(() => tab.text()))),
              }),
              wait: codemode.Tool.make({
                ...SPEC.wait,
                run: (input) => Effect.sleep(Math.max(0, Math.min(WAIT_MAX, input.ms))).pipe(Effect.as(null)),
              }),
              evaluate: codemode.Tool.make({
                ...SPEC.evaluate,
                run: (input) =>
                  guard(
                    Effect.gen(function* () {
                      const tab = yield* active()
                      const url = yield* Effect.promise(() => tab.url())
                      const site = siteOf(url)
                      // JavaScript in a signed-in page is the sharpest edge; asked
                      // once per site in a run so a loop does not ask fifty times.
                      if (!evaluating.has(site)) {
                        yield* ctx.ask({
                          permission: "browser_evaluate",
                          patterns: [url],
                          always: [],
                          metadata: { url, expression: input.expression },
                        })
                        evaluating.add(site)
                      }
                      return yield* Effect.promise(() =>
                        tab.evaluate<unknown>(`(() => { return (${input.expression}) })()`),
                      )
                    }),
                  ),
              }),
            },
          }

          const runtime = codemode.CodeMode.make({
            tools,
            limits: {
              timeoutMs: Math.min(TIMEOUT_MAX, Math.max(1, params.timeout ?? TIMEOUT)) * 1000,
              maxOutputBytes: OUTPUT_MAX,
            },
            onToolCallStart: () =>
              Effect.suspend(() => {
                calls++
                return ctx.metadata({ title: params.name ?? "browser script", metadata: { url: start, calls } })
              }),
          })

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })
          // The program sees `args` as a variable; kept on the first line so
          // the lines of its diagnostics still match the code that was written.
          const source = `const args = ${JSON.stringify(params.args ?? {})}; ${code}`
          const result = yield* Effect.raceFirst(
            runtime.execute(source),
            abort.pipe(
              Effect.as<CodeMode.Result>({
                ok: false,
                error: { kind: "ExecutionFailure", message: "Execution cancelled." },
                toolCalls: [],
              }),
            ),
          )

          const tab = yield* browser.tab()
          const page = yield* Effect.promise(() => where(tab))
          const logs = result.logs?.length ? ["", "Logs:", ...result.logs] : []
          const footer = ["", `Page now: ${page.url}${page.title ? ` (${page.title})` : ""}`]

          // A saved program that stops working is how the agent learns the site changed.
          const rerun = params.code === undefined && params.name !== undefined && host !== undefined
          if (rerun) yield* Effect.promise(() => BrowserSite.recordRun(host, params.name!, result.ok))

          if (!result.ok) {
            const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
            const fix = rerun
              ? [
                  "",
                  `The saved program "${params.name}" failed. If the site changed, fix it: pass the corrected code with the same name.`,
                ]
              : []
            throw new Error([result.error.message, ...hints, ...logs, ...footer, ...fix].join("\n"))
          }

          const keep = params.code !== undefined && params.name !== undefined
          if (keep) yield* Effect.promise(() => save(host, params.name!, code, params.description ?? ""))
          const value = typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2)
          return {
            output: [
              value ?? "null",
              ...logs,
              ...footer,
              ...(keep
                ? [
                    `Saved as "${params.name}"${host ? ` for ${host}` : ""}; run it again with just name (and args). It is listed with its description whenever you land on this site.`,
                  ]
                : []),
            ].join("\n"),
            title: params.name ?? "browser script",
            metadata: { url: page.url, calls, ...(keep ? { saved: params.name } : {}) },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

async function where(tab: Tab) {
  const [url, title] = await Promise.all([tab.url(), tab.title()])
  return { url, title }
}

function siteOf(url: string) {
  return URL.canParse(url) ? new URL(url).host : url
}

/** Programs saved before they were kept per site, from any page. */
function listLoose() {
  try {
    return readdirSync(SCRIPTS)
      .filter((file) => file.endsWith(".js"))
      .map((file) => file.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

/** A saved program: the site's own first, then one saved before programs were kept per site. */
async function load(host: string | undefined, name?: string) {
  if (!name) throw new Error("Give the program as code, or the name of a saved one.")
  if (!NAME.test(name)) throw new Error("A program name takes letters, digits, - and _, up to 64 of them.")
  const own = host ? await BrowserSite.loadProgram(host, name) : undefined
  if (own !== undefined) return own
  return fs.readFile(path.join(SCRIPTS, `${name}.js`), "utf8").catch(async () => {
    const known = [...(host ? (await BrowserSite.programs(host)).map((program) => program.name) : []), ...listLoose()]
    throw new Error(
      `No saved program is called "${name}"${host ? ` for ${host}` : ""}. ${known.length ? `Saved: ${known.join(", ")}.` : "None are saved yet."}`,
    )
  })
}

/** Keeps a program for the site it ran on; one started off the web is kept loose. */
async function save(host: string | undefined, name: string, code: string, description: string) {
  if (host) return BrowserSite.saveProgram(host, name, code, description)
  await fs.mkdir(SCRIPTS, { recursive: true })
  await fs.writeFile(path.join(SCRIPTS, `${name}.js`), code, "utf8")
}
