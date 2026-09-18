import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Browser, type BrowserEvent } from "@/browser/session"
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
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { and, gte, sql } from "drizzle-orm"
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
  UsageSpendQuery,
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

    const browserFrame = Effect.fn("ExperimentalHttpApi.browserFrame")(function* () {
      const browser = yield* Browser.Service
      // Deliberately `current()`, not `tab()`: looking at the panel must never
      // be what starts a browser.
      const tab = yield* browser.current()
      if (!tab) return { running: false }
      const [url, title, image] = yield* Effect.promise(async () => {
        const shot = await tab.screenshot().catch(() => undefined)
        return [
          await tab.url(),
          await tab.title(),
          shot ? `data:image/png;base64,${shot.toString("base64")}` : undefined,
        ] as const
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
      .handle("webVideoModels", webVideoModels)
      .handle("webVideoSettings", webVideoSettings)
      .handle("webVideoSettingsUpdate", webVideoSettingsUpdate)
      .handle("browserStatus", browserStatus)
      .handle("browserFrame", browserFrame)
      .handleRaw("browserStream", browserStream)
      .handle("browserInput", browserInput)
      .handle("browserControl", browserControl)
  }),
)
