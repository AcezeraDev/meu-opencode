import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Browser, type BrowserEvent } from "@/browser/session"
import { BrowserTrail } from "@/browser/trail"
import { BrowserNotebook } from "@/browser/notebook"
import { BrowserSite } from "@/browser/site"
import { BrowserLessons } from "@/browser/lessons"
import { SessionWeek } from "@/session/week"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { nanoGPT, resolveApiKey, toWebVideoError } from "@/web-video/provider"
import { WebVideoSettings } from "@/web-video/settings"
import { Provider } from "@/provider/provider"
import { Roteia } from "@/provider/roteia"
import { Ollama } from "@/provider/ollama"
import { Hardware } from "@/provider/hardware"
import { DatasetExporter } from "@/dataset/export"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable, SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { SessionPace } from "@/session/pace"
import { and, desc, eq, gte, sql } from "drizzle-orm"
import { Effect, Option, Queue } from "effect"
import * as Stream from "effect/Stream"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  BrowserCommand,
  BrowserInput,
  ConsoleSwitchPayload,
  SessionListQuery,
  ToolListQuery,
  UsageEtaQuery,
  BrowserSiteForgetQuery,
  BrowserSiteQuery,
  UsageSpendQuery,
  UsageWeekQuery,
  RoteiaStatusQuery,
  DatasetExportQuery,
  WebVideoDefaults,
  WorktreeApiError,
} from "../groups/experimental"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const auth = yield* Auth.Service
    const { db } = yield* Database.Service
    // Response schemas require JSON values; optional fields left as `undefined`
    // (e.g. an unset resolution) must be dropped before encoding.
    const toJson = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value))

    const webVideoModels = Effect.fn("ExperimentalHttpApi.webVideoModels")(function* () {
      const key = yield* resolveApiKey(auth)
      const settings = yield* Effect.promise(() => WebVideoSettings.load())
      const models = yield* Effect.promise(() =>
        nanoGPT({ apiKey: async () => key })
          .getModels()
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error: toWebVideoError(error, [key]).message }),
          ),
      )
      return {
        configured: !!key,
        defaultModel: settings.model,
        models: models.ok ? models.value.map(toJson) : [],
        ...(models.ok ? {} : { error: models.error }),
      }
    })

    const webVideoSettings = Effect.fn("ExperimentalHttpApi.webVideoSettings")(function* () {
      return toJson(yield* Effect.promise(() => WebVideoSettings.load()))
    })

    const webVideoSettingsUpdate = Effect.fn("ExperimentalHttpApi.webVideoSettingsUpdate")(function* (ctx: {
      payload: typeof WebVideoDefaults.Type
    }) {
      return toJson(yield* Effect.promise(() => WebVideoSettings.save(ctx.payload)))
    })

    const browserStatus = Effect.fn("ExperimentalHttpApi.browserStatus")(function* () {
      return yield* (yield* Browser.Service).status()
    })

    const browserTrail = Effect.fn("ExperimentalHttpApi.browserTrail")(function* (ctx: {
      params: { sessionID: string; callID: string }
    }) {
      const image = yield* Effect.promise(() => BrowserTrail.read(ctx.params.sessionID, ctx.params.callID))
      return image ? { image: `data:image/jpeg;base64,${image.toString("base64")}` } : {}
    })

    const browserFrame = Effect.fn("ExperimentalHttpApi.browserFrame")(function* () {
      const browser = yield* Browser.Service
      // Deliberately `current()`, not `tab()`: looking at the panel must never
      // be what starts a browser.
      const tab = yield* browser.current()
      if (!tab) return { running: false }
      const [url, title, image] = yield* Effect.promise(async () => {
        // A JPEG straight off the screen, polled every second and a half while
        // the strip is open: a full-size PNG, with the cursor hidden and shown
        // around it, was megabytes a poll through the extension relay, in
        // front of the agent's own commands.
        const shot = await tab.frame().catch(() => undefined)
        return [await tab.url(), await tab.title(), shot ? `data:image/jpeg;base64,${shot.data}` : undefined] as const
      })
      return { running: true, url, title, image }
    })

    const browserStream = Effect.fn("ExperimentalHttpApi.browserStream")(function* () {
      const browser = yield* Browser.Service
      // Frames can arrive faster than a client reads them, so only the newest
      // one waits to be sent; status and activity are small and all delivered.
      let latest: BrowserEvent | undefined
      const queue = yield* Queue.unbounded<BrowserEvent | "frame">()
      // Subscribed eagerly, like the event route, so nothing published while
      // the response is starting is lost.
      const unsubscribe = yield* browser.subscribe((event) => {
        if (event.type !== "frame") {
          Queue.offerUnsafe(queue, event)
          return
        }
        const waiting = latest !== undefined
        latest = event
        if (!waiting) Queue.offerUnsafe(queue, "frame")
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

      const events = Stream.fromQueue(queue).pipe(
        Stream.map((item): BrowserEvent | { type: "heartbeat" } => {
          if (item !== "frame") return item
          const frame = latest ?? { type: "heartbeat" as const }
          latest = undefined
          return frame
        }),
      )
      const heartbeat = Stream.tick("10 seconds").pipe(
        Stream.drop(1),
        Stream.map(() => ({ type: "heartbeat" as const })),
      )
      return HttpServerResponse.stream(
        events.pipe(
          Stream.merge(heartbeat, { haltStrategy: "left" }),
          Stream.map(
            (data): Sse.Event => ({ _tag: "Event", event: "message", id: undefined, data: JSON.stringify(data) }),
          ),
          Stream.pipeThroughChannel(Sse.encode()),
          Stream.encodeText,
        ),
        {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          },
        },
      )
    })

    const browserInput = Effect.fn("ExperimentalHttpApi.browserInput")(function* (ctx: {
      payload: typeof BrowserInput.Type
    }) {
      yield* (yield* Browser.Service).input(ctx.payload)
      return true
    })

    const browserControl = Effect.fn("ExperimentalHttpApi.browserControl")(function* (ctx: {
      payload: typeof BrowserCommand.Type
    }) {
      return yield* (yield* Browser.Service).control(ctx.payload)
    })

    const usageSpend = Effect.fn("ExperimentalHttpApi.usageSpend")(function* (ctx: {
      query: typeof UsageSpendQuery.Type
    }) {
      const since = Number(ctx.query.since)
      const rows = yield* db
        .select({
          total: sql<number>`coalesce(sum(json_extract(${MessageTable.data}, '$.cost')), 0)`,
          messages: sql<number>`count(*)`,
        })
        .from(MessageTable)
        .where(
          and(
            gte(MessageTable.time_created, Number.isFinite(since) ? since : 0),
            sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return { total: Number(rows[0]?.total ?? 0), messages: Number(rows[0]?.messages ?? 0) }
    })

    const usageWeek = Effect.fn("ExperimentalHttpApi.usageWeek")(function* (ctx: {
      query: typeof UsageWeekQuery.Type
    }) {
      const asked = Number(ctx.query.since)
      const since = Number.isFinite(asked) ? asked : Date.now() - 7 * 24 * 60 * 60 * 1000
      const field = (path: string) => sql`json_extract(${MessageTable.data}, ${path})`
      const part = (path: string) => sql`json_extract(${PartTable.data}, ${path})`
      const messages = yield* db
        .select({
          id: MessageTable.id,
          sessionID: MessageTable.session_id,
          providerID: sql<string | null>`${field("$.providerID")}`,
          modelID: sql<string | null>`${field("$.modelID")}`,
          cost: sql<number | null>`${field("$.cost")}`,
          created: sql<number | null>`${field("$.time.created")}`,
          completed: sql<number | null>`${field("$.time.completed")}`,
        })
        .from(MessageTable)
        .where(and(gte(MessageTable.time_created, since), sql`${field("$.role")} = 'assistant'`))
        .all()
        .pipe(Effect.orDie)
      const tools = yield* db
        .select({
          sessionID: PartTable.session_id,
          messageID: PartTable.message_id,
          tool: sql<string | null>`${part("$.tool")}`,
          status: sql<string | null>`${part("$.state.status")}`,
          error: sql<string | null>`${part("$.state.error")}`,
          start: sql<number | null>`${part("$.state.time.start")}`,
          end: sql<number | null>`${part("$.state.time.end")}`,
        })
        .from(PartTable)
        .where(and(gte(PartTable.time_created, since), sql`${part("$.type")} = 'tool'`))
        .all()
        .pipe(Effect.orDie)
      const ids = [...new Set(messages.map((message) => message.sessionID))]
      const titles = ids.length
        ? yield* db
            .select({ id: SessionTable.id, title: SessionTable.title, parentID: SessionTable.parent_id })
            .from(SessionTable)
            .where(gte(SessionTable.time_updated, since))
            .all()
            .pipe(Effect.orDie)
        : []
      const notebook = yield* Effect.promise(() => BrowserNotebook.countSince(since))
      return SessionWeek.summarize({ since, messages, tools, sessions: titles, notebook })
    })

    const siteInfo = async (url: string) => {
      const host = BrowserSite.hostOf(url)
      if (!host) return undefined
      const [notes, programs] = await Promise.all([BrowserSite.notes(host), BrowserSite.programs(host)])
      return {
        host,
        notes,
        programs: programs.map((item) => ({
          name: item.name,
          description: item.description,
          runs: item.runs,
          failures: item.failures,
        })),
      }
    }

    const browserSite = Effect.fn("ExperimentalHttpApi.browserSite")(function* (ctx: {
      query: typeof BrowserSiteQuery.Type
    }) {
      return yield* Effect.promise(() => siteInfo(ctx.query.url))
    })

    // Reads the page the person has open (in extension mode, their own tab), so
    // a browser that is not there is an answer to show, not a failure.
    const browserLessons = Effect.fn("ExperimentalHttpApi.browserLessons")(function* () {
      const browser = yield* Browser.Service
      const empty = { course: "", url: "", sections: [] }
      const tab = yield* browser.tab().pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!tab) return { ...empty, error: "browser" }
      const read = yield* Effect.promise(() =>
        tab.evaluate<BrowserLessons.Course>(BrowserLessons.READ).catch(() => undefined),
      )
      if (!read) return { ...empty, error: "page" }
      if (read.sections.length === 0) return { ...read, error: "index" }
      return read
    })

    const browserSiteForget = Effect.fn("ExperimentalHttpApi.browserSiteForget")(function* (ctx: {
      query: typeof BrowserSiteForgetQuery.Type
    }) {
      const host = BrowserSite.hostOf(ctx.query.url)
      const number = Number(ctx.query.note)
      if (host && Number.isInteger(number) && number > 0)
        yield* Effect.promise(() => BrowserSite.removeNotes(host, [number]))
      return yield* Effect.promise(() => siteInfo(ctx.query.url))
    })

    const notebook = Effect.fn("ExperimentalHttpApi.notebook")(function* () {
      return yield* Effect.promise(() => BrowserNotebook.list())
    })

    const notebookSubject = Effect.fn("ExperimentalHttpApi.notebookSubject")(function* (ctx: {
      params: { subject: string }
    }) {
      return yield* Effect.promise(() => BrowserNotebook.entries(ctx.params.subject))
    })

    const roteiaStatus = Effect.fn("ExperimentalHttpApi.roteiaStatus")(function* (ctx: {
      query: typeof RoteiaStatusQuery.Type
    }) {
      // The same places the provider reads a key from, most specific first.
      const stored = yield* auth.get(Roteia.ID).pipe(Effect.orElseSucceed(() => undefined))
      const fromEnv = process.env[Roteia.ENV]?.trim()
      const fromConfig = (yield* config.get()).provider?.[Roteia.ID]?.options?.apiKey
      const found =
        stored?.type === "api"
          ? { key: stored.key, source: "api" as const }
          : fromEnv
            ? { key: fromEnv, source: "env" as const }
            : typeof fromConfig === "string" && fromConfig
              ? { key: fromConfig, source: "config" as const }
              : undefined
      const providers = yield* (yield* Provider.Service).list()
      const models = Object.keys(providers[Roteia.ID]?.models ?? {}).length
      if (!found) return { configured: false, models }
      if (!ctx.query.test) return { configured: true, source: found.source, models }
      const check = yield* Effect.promise(() => Roteia.check(found.key))
      return { configured: true, source: found.source, models, check }
    })

    const datasetExport = Effect.fn("ExperimentalHttpApi.datasetExport")(function* (ctx: {
      query: typeof DatasetExportQuery.Type
    }) {
      const min = ctx.query.min ?? "approved"
      // Every project's sessions: rating lives in each session's metadata.
      const rated = yield* db
        .select({
          id: SessionTable.id,
          title: SessionTable.title,
          directory: SessionTable.directory,
          metadata: SessionTable.metadata,
        })
        .from(SessionTable)
        .where(sql`json_extract(${SessionTable.metadata}, '$.ratings') is not null`)
        .all()
        .pipe(Effect.orDie)
      const list = yield* Effect.forEach(rated, (session) =>
        sessions.messages({ sessionID: session.id as SessionID }).pipe(
          Effect.map((messages) =>
            DatasetExporter.examples(
              { id: session.id, title: session.title, directory: session.directory, metadata: session.metadata ?? undefined },
              messages,
              min,
            ),
          ),
          Effect.orElseSucceed(() => [] as DatasetExporter.Example[]),
        ),
      )
      const examples = list.flat()
      const file = yield* Effect.promise(() => DatasetExporter.write(examples, min))
      return {
        file,
        examples: examples.length,
        sessions: new Set(examples.map((example) => example.meta.session)).size,
        rated: rated.reduce((sum, session) => sum + Object.keys(DatasetExporter.ratings(session.metadata ?? undefined)).length, 0),
      }
    })

    const ollamaStatus = Effect.fn("ExperimentalHttpApi.ollamaStatus")(function* () {
      const settings = Ollama.settings((yield* config.get()).provider?.[Ollama.ID]?.options, process.env)
      const [version, tags, hardware] = yield* Effect.promise(() =>
        Promise.all([Ollama.probe(settings.host), Ollama.tags(settings.host), Hardware.detect()]),
      )
      const providers = yield* (yield* Provider.Service).list()
      const connected = providers[Ollama.ID]
      const models = Object.values(connected?.models ?? {}).map((model) => ({
        id: model.id,
        context: model.limit.context,
        tools: model.capabilities.toolcall,
        vision: model.capabilities.input.image,
      }))
      return {
        running: version !== undefined,
        host: settings.host,
        version,
        connected: connected !== undefined,
        models,
        hardware: {
          platform: hardware.platform,
          cpu: hardware.cpu.model,
          threads: hardware.cpu.threads,
          ramGB: hardware.ramGB,
          freeDiskGB: hardware.freeDiskGB,
          gpus: hardware.gpus.map((gpu) => ({ name: gpu.name, vramGB: gpu.vramGB, dedicated: gpu.dedicated })),
        },
        recommendation: Hardware.recommend(
          hardware,
          tags.map((tag) => tag.name),
        ),
      }
    })

    /** Past requests over this window teach how long work takes. */
    const PACE_WINDOW = 60 * 24 * 60 * 60 * 1000
    /** The history changes slowly; reading it on every poll would be waste. */
    const PACE_CACHE_MS = 60_000
    let history: { at: number; runs: SessionPace.Run[]; steps: { model: string; ms: number }[] } | undefined
    /**
     * Largest todo list per message, kept between loads. Finding them means
     * opening every part's JSON, tool outputs and all: across two months that
     * held the server still for up to half a second every minute, browser relay
     * and event stream included. After the first load only new parts are read.
     */
    const todosByMessage = new Map<string, number>()
    let todosRead = 0

    const loadHistory = Effect.fn("ExperimentalHttpApi.paceHistory")(function* () {
      if (history && Date.now() - history.at < PACE_CACHE_MS) return history
      const now = Date.now()
      const since = now - PACE_WINDOW
      const assistants = yield* db
        .select({
          id: MessageTable.id,
          created: MessageTable.time_created,
          parent: sql<string | null>`json_extract(${MessageTable.data}, '$.parentID')`,
          model: sql<string | null>`json_extract(${MessageTable.data}, '$.modelID')`,
          completed: sql<number | null>`json_extract(${MessageTable.data}, '$.time.completed')`,
        })
        .from(MessageTable)
        .where(
          and(gte(MessageTable.time_created, since), sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`),
        )
        .all()
        .pipe(Effect.orDie)
      const users = yield* db
        .select({ id: MessageTable.id, created: MessageTable.time_created })
        .from(MessageTable)
        .where(and(gte(MessageTable.time_created, since), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`))
        .all()
        .pipe(Effect.orDie)
      const plans = yield* db
        .select({
          message: PartTable.message_id,
          todos: sql<number | null>`json_array_length(json_extract(${PartTable.data}, '$.state.input.todos'))`,
        })
        .from(PartTable)
        .where(
          and(
            // A part written during the last read may have been missed by it.
            gte(PartTable.time_created, Math.max(since, todosRead - PACE_CACHE_MS)),
            sql`json_extract(${PartTable.data}, '$.tool') = 'todowrite'`,
          ),
        )
        .all()
        .pipe(Effect.orDie)
      todosRead = now
      const started = new Map<string, number>(users.map((user) => [user.id, user.created]))
      for (const plan of plans) {
        todosByMessage.set(plan.message, Math.max(todosByMessage.get(plan.message) ?? 0, Number(plan.todos ?? 0)))
      }
      const runs = new Map<string, SessionPace.Run>()
      const steps: { model: string; ms: number }[] = []
      for (const message of assistants) {
        const model = message.model ?? ""
        if (message.completed) steps.push({ model, ms: message.completed - message.created })
        const start = message.parent ? started.get(message.parent) : undefined
        if (!message.parent || start === undefined) continue
        const run = runs.get(message.parent) ?? { model, start, end: start, steps: 0, todos: 0 }
        run.steps++
        run.end = Math.max(run.end, message.completed ?? message.created)
        run.todos = Math.max(run.todos, todosByMessage.get(message.id) ?? 0)
        runs.set(message.parent, run)
      }
      history = { at: Date.now(), runs: [...runs.values()], steps }
      return history
    })

    const usageEta = Effect.fn("ExperimentalHttpApi.usageEta")(function* (ctx: { query: typeof UsageEtaQuery.Type }) {
      const now = Date.now()
      const sessionID = ctx.query.sessionID as SessionID
      const last = yield* db
        .select({
          created: MessageTable.time_created,
          model: sql<string | null>`json_extract(${MessageTable.data}, '$.model.modelID')`,
        })
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, sessionID), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`))
        .orderBy(desc(MessageTable.time_created))
        .limit(1)
        .all()
        .pipe(Effect.orDie)
      const current = last[0]
      if (!current) return { elapsed: 0, runs: 0 }
      const past = yield* loadHistory()
      const pace = SessionPace.summarize({
        // The request in progress is not history yet.
        runs: past.runs.filter((run) => run.start !== current.created),
        steps: past.steps,
        model: current.model ?? undefined,
      })
      // A todo list survives from one request to the next; only one this
      // request has touched says anything about it.
      const todos = yield* db
        .select({ status: TodoTable.status })
        .from(TodoTable)
        .where(and(eq(TodoTable.session_id, sessionID), gte(TodoTable.time_updated, current.created)))
        .all()
        .pipe(Effect.orDie)
      const plan =
        todos.length > 0
          ? {
              total: todos.filter((todo) => todo.status !== "cancelled").length,
              done: todos.filter((todo) => todo.status === "completed").length,
              active: todos.filter((todo) => todo.status === "in_progress").length,
            }
          : undefined
      const elapsed = Math.max(0, now - current.created)
      const result = SessionPace.estimate({ elapsed, todos: plan }, pace)
      return toJson({
        elapsed,
        remaining: result?.remaining,
        basis: result?.basis,
        typical: pace.runMedianMs,
        runs: pace.runs,
        todos: plan ? { total: plan.total, done: plan.done } : undefined,
      }) as { elapsed: number; runs: number }
    })

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.experimentalBackgroundSubagents }
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.experimentalBackgroundSubagents) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("resource", resource)
      .handle("usageSpend", usageSpend)
      .handle("roteiaStatus", roteiaStatus)
      .handle("ollamaStatus", ollamaStatus)
      .handle("datasetExport", datasetExport)
      .handle("usageEta", usageEta)
      .handle("usageWeek", usageWeek)
      .handle("browserSite", browserSite)
      .handle("browserSiteForget", browserSiteForget)
      .handle("browserLessons", browserLessons)
      .handle("notebook", notebook)
      .handle("notebookSubject", notebookSubject)
      .handle("webVideoModels", webVideoModels)
      .handle("webVideoSettings", webVideoSettings)
      .handle("webVideoSettingsUpdate", webVideoSettingsUpdate)
      .handle("browserStatus", browserStatus)
      .handle("browserFrame", browserFrame)
      .handle("browserTrail", browserTrail)
      .handleRaw("browserStream", browserStream)
      .handle("browserInput", browserInput)
      .handle("browserControl", browserControl)
  }),
)
