import { Agent } from "@/agent/agent"
import { AgentRuntime } from "@/agent/runtime"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@opencode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Config } from "@/config/config"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  AgentGenerateInput,
  AgentRuntimeUpdateInput,
  AgentWriteInput,
  ApiAgentFileError,
  ApiAgentGenerateError,
  ApiAgentMutationError,
  ApiAgentRuntimeError,
  ApiVcsApplyError,
} from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"
import { agentFilePath, serializeAgent, validateAgentMutation } from "../agent-file"
import fs from "fs/promises"

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const agentRuntime = yield* AgentRuntime.Service
    const config = yield* Config.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const mutationError = (reason: "invalid-name" | "native") =>
      new ApiAgentMutationError({
        name: "AgentMutationError",
        data: {
          reason,
          message:
            reason === "invalid-name"
              ? "Agent names may contain only lowercase letters, numbers, and hyphens."
              : "Native agents cannot be changed or deleted.",
        },
      })

    const mutationTarget = Effect.fnUntraced(function* (name: string) {
      const invalid = validateAgentMutation(name, yield* agent.list())
      if (invalid) return yield* mutationError(invalid)
      const file = agentFilePath(Global.Path.config, name)
      if (!file) return yield* mutationError("invalid-name")
      return file
    })

    const refreshAgents = Effect.fnUntraced(function* () {
      yield* config.invalidate()
      yield* agent.invalidate()
    })

    const updateAgent = Effect.fn("InstanceHttpApi.agentUpdate")(function* (ctx: {
      params: { name: string }
      payload: typeof AgentWriteInput.Type
    }) {
      const file = yield* mutationTarget(ctx.params.name)
      yield* Effect.tryPromise({
        try: async () => {
          await fs.mkdir(file.directory, { recursive: true })
          await fs.writeFile(file.target, serializeAgent(ctx.payload), "utf8")
        },
        catch: (error) =>
          new ApiAgentFileError({
            name: "AgentFileError",
            data: { message: error instanceof Error ? error.message : String(error) },
          }),
      })
      yield* refreshAgents()
      return yield* agent.get(ctx.params.name)
    })

    const deleteAgent = Effect.fn("InstanceHttpApi.agentDelete")(function* (ctx: { params: { name: string } }) {
      const file = yield* mutationTarget(ctx.params.name)
      yield* agentRuntime.stop(ctx.params.name)
      yield* Effect.tryPromise({
        try: () => fs.rm(file.target, { force: true }),
        catch: (error) =>
          new ApiAgentFileError({
            name: "AgentFileError",
            data: { message: error instanceof Error ? error.message : String(error) },
          }),
      })
      yield* refreshAgents()
      return true
    })

    const generateAgent = Effect.fn("InstanceHttpApi.agentGenerate")(function* (ctx: {
      payload: typeof AgentGenerateInput.Type
    }) {
      return yield* agent.generate(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiAgentGenerateError({
              name: "AgentGenerateError",
              data: { message: error.message },
            }),
        ),
      )
    })

    const getAgentRuntime = Effect.fn("InstanceHttpApi.agentRuntime")(function* () {
      return yield* agentRuntime.list()
    })

    const updateAgentRuntime = Effect.fn("InstanceHttpApi.agentRuntimeUpdate")(function* (ctx: {
      params: { name: string }
      payload: typeof AgentRuntimeUpdateInput.Type
    }) {
      return yield* (ctx.payload.enabled ? agentRuntime.start(ctx.params.name) : agentRuntime.stop(ctx.params.name)).pipe(
        Effect.mapError(
          (error) =>
            new ApiAgentRuntimeError({
              name: "AgentRuntimeError",
              data: { message: error.message },
            }),
        ),
      )
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("agentGenerate", generateAgent)
      .handle("agentRuntime", getAgentRuntime)
      .handle("agentRuntimeUpdate", updateAgentRuntime)
      .handle("agentUpdate", updateAgent)
      .handle("agentDelete", deleteAgent)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
