import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Context, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Agent } from "./agent"

export const Status = Schema.Literals(["starting", "running", "waiting", "error", "stopped"])
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  status: Status,
  sessionID: Schema.optional(SessionID),
  startedAt: Schema.optional(Schema.Finite),
  lastRunAt: Schema.optional(Schema.Finite),
  nextRunAt: Schema.optional(Schema.Finite),
  updatedAt: Schema.Finite,
  cycles: Schema.Finite,
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "AgentRuntime" })
export type Info = typeof Info.Type

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("AgentRuntimeUnavailable", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly start: (name: string) => Effect.Effect<Info, Unavailable>
  readonly stop: (name: string) => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentRuntime") {}

type Entry = {
  info: Info
  fiber?: Fiber.Fiber<never, never>
}

const interval = 5_000
const retryInterval = 10_000
const continuousSystem = [
  "MODO DE EXECUÇÃO CONTÍNUA AUTORIZADO PELO USUÁRIO.",
  "Execute agora o objetivo definido nas instruções deste agente.",
  "Você está autorizado a usar as ferramentas de navegador e concluir ações sem pedir confirmação adicional.",
  "Não encerre o trabalho por iniciativa própria. Processe o que estiver pendente e preserve contexto suficiente para o próximo ciclo.",
  "Não repita uma ação que já foi concluída. Se não houver trabalho novo, finalize este ciclo de forma breve; o supervisor iniciará outro.",
].join("\n")
const continuousPrompt =
  "Continue a execução automática do seu objetivo. Verifique se existe trabalho novo, execute-o e evite repetir ações já concluídas."

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service

    const state = yield* InstanceState.make(
      Effect.fn("AgentRuntime.state")(function* () {
        const scope = yield* Scope.Scope
        const runs = new Map<string, Entry>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(
              runs.values(),
              (entry) =>
                Effect.gen(function* () {
                  if (entry.info.sessionID) yield* prompts.cancel(entry.info.sessionID)
                  if (entry.fiber) yield* Fiber.interrupt(entry.fiber)
                }),
              { concurrency: "unbounded", discard: true },
            )
            runs.clear()
          }),
        )
        return { runs, scope }
      }),
    )

    const setInfo = (entry: Entry, patch: Partial<Info>) =>
      Effect.sync(() => {
        entry.info = { ...entry.info, ...patch, updatedAt: Date.now() }
        return entry.info
      })

    const run = Effect.fn("AgentRuntime.run")(function* (entry: Entry) {
      const sessionID = entry.info.sessionID
      if (!sessionID) return yield* Effect.die("Continuous agent has no session")

      const cycle = Effect.gen(function* () {
        const current = yield* agents.get(entry.info.name)
        if (!current) return yield* new Unavailable({ message: `Agent not found: ${entry.info.name}` })

        yield* setInfo(entry, { status: "running", error: undefined, nextRunAt: undefined })
        yield* prompts.prompt({
          sessionID,
          agent: current.name,
          model: current.model,
          variant: current.variant,
          system: continuousSystem,
          parts: [{ type: "text", text: continuousPrompt }],
        })
        const completed = Date.now()
        yield* setInfo(entry, {
          status: "waiting",
          cycles: entry.info.cycles + 1,
          lastRunAt: completed,
          nextRunAt: completed + interval,
        })
        yield* Effect.sleep(interval)
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt
          const failed = Date.now()
          return setInfo(entry, {
            status: "error",
            error: Cause.pretty(cause).split(" at ")[0],
            lastRunAt: failed,
            nextRunAt: failed + retryInterval,
          }).pipe(Effect.andThen(Effect.sleep(retryInterval)))
        }),
      )

      return yield* cycle.pipe(Effect.forever)
    })

    const list = Effect.fn("AgentRuntime.list")(function* () {
      return Array.from((yield* InstanceState.get(state)).runs.values()).map((entry) => ({ ...entry.info }))
    })

    const start = Effect.fn("AgentRuntime.start")(function* (name: string) {
      const data = yield* InstanceState.get(state)
      const existing = data.runs.get(name)
      if (existing?.info.enabled) return { ...existing.info }

      const agent = yield* agents.get(name)
      if (!agent) return yield* new Unavailable({ message: `Agent not found: ${name}` })
      if (agent.mode === "subagent") {
        return yield* new Unavailable({ message: `Subagent cannot run continuously: ${name}` })
      }

      const sessionID = existing?.info.sessionID
        ? existing.info.sessionID
        : (yield* sessions.create({
            title: `Agente contínuo: ${name}`,
            agent: name,
            model: agent.model
              ? { providerID: agent.model.providerID, id: agent.model.modelID, variant: agent.variant }
              : undefined,
            metadata: { continuousAgent: name },
            permission: [
              ...agent.permission,
              { permission: "browser", pattern: "*", action: "allow" },
            ] satisfies PermissionV1.Ruleset,
          })).id
      const now = Date.now()
      const entry: Entry = existing ?? {
        info: {
          name,
          enabled: true,
          status: "starting",
          sessionID,
          startedAt: now,
          updatedAt: now,
          cycles: 0,
        },
      }
      entry.info = {
        ...entry.info,
        enabled: true,
        status: "starting",
        sessionID,
        startedAt: entry.info.startedAt ?? now,
        updatedAt: now,
        error: undefined,
        nextRunAt: undefined,
      }
      data.runs.set(name, entry)
      entry.fiber = yield* run(entry).pipe(Effect.forkIn(data.scope, { startImmediately: true }))
      return { ...entry.info }
    })

    const stop = Effect.fn("AgentRuntime.stop")(function* (name: string) {
      const data = yield* InstanceState.get(state)
      const entry = data.runs.get(name)
      if (!entry) {
        return {
          name,
          enabled: false,
          status: "stopped" as const,
          updatedAt: Date.now(),
          cycles: 0,
        }
      }

      yield* setInfo(entry, { enabled: false, status: "stopped", error: undefined, nextRunAt: undefined })
      if (entry.info.sessionID) yield* prompts.cancel(entry.info.sessionID)
      if (entry.fiber) yield* Fiber.interrupt(entry.fiber)
      entry.fiber = undefined
      return { ...entry.info }
    })

    return Service.of({ list, start, stop })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Session.node, SessionPrompt.node],
})

export * as AgentRuntime from "./runtime"
