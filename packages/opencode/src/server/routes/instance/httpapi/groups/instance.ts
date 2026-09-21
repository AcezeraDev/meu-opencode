import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { AVAILABLE_AGENT_PERMISSIONS } from "../agent-file"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AgentRuntime } from "@/agent/runtime"

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
}).annotate({ identifier: "Path" })

export const VcsDiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  mode: Vcs.Mode,
  context: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export class ApiVcsApplyError extends Schema.ErrorClass<ApiVcsApplyError>("VcsApplyError")(
  {
    name: Schema.Literal("VcsApplyError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["non-git", "not-clean"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export const AgentWriteInput = Schema.Struct({
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["all", "primary", "subagent"]),
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.String,
  temperature: Schema.optional(Schema.Finite),
  topP: Schema.optional(Schema.Finite),
  color: Schema.optional(
    Schema.Union([
      Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
      Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
    ]),
  ),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  steps: Schema.optional(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0))),
  permissions: Schema.Array(Schema.Literals(AVAILABLE_AGENT_PERMISSIONS)),
}).annotate({ identifier: "AgentWriteInput" })

export const AgentGenerateInput = Schema.Struct({
  description: Schema.String.check(Schema.isMinLength(1)),
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
    }),
  ),
}).annotate({ identifier: "AgentGenerateInput" })

export const AgentGenerated = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
}).annotate({ identifier: "AgentGenerated" })

export const AgentRuntimeUpdateInput = Schema.Struct({
  enabled: Schema.Boolean,
}).annotate({ identifier: "AgentRuntimeUpdateInput" })

export class ApiAgentMutationError extends Schema.ErrorClass<ApiAgentMutationError>("AgentMutationError")(
  {
    name: Schema.Literal("AgentMutationError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["invalid-name", "native"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiAgentFileError extends Schema.ErrorClass<ApiAgentFileError>("AgentFileError")(
  {
    name: Schema.Literal("AgentFileError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 500 },
) {}

export class ApiAgentGenerateError extends Schema.ErrorClass<ApiAgentGenerateError>("AgentGenerateError")(
  {
    name: Schema.Literal("AgentGenerateError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiAgentRuntimeError extends Schema.ErrorClass<ApiAgentRuntimeError>("AgentRuntimeError")(
  {
    name: Schema.Literal("AgentRuntimeError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export const InstancePaths = {
  dispose: "/instance/dispose",
  path: "/path",
  vcs: "/vcs",
  vcsStatus: "/vcs/status",
  vcsDiff: "/vcs/diff",
  vcsDiffRaw: "/vcs/diff/raw",
  vcsApply: "/vcs/apply",
  command: "/command",
  agent: "/agent",
  agentGenerate: "/agent/generate",
  agentRuntime: "/agent/runtime",
  agentRuntimeByName: "/agent/:name/runtime",
  agentByName: "/agent/:name",
  skill: "/skill",
  lsp: "/lsp",
  formatter: "/formatter",
} as const

export const InstanceApi = HttpApi.make("instance")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.post("dispose", InstancePaths.dispose, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Instance disposed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.get("path", InstancePaths.path, {
          query: WorkspaceRoutingQuery,
          success: PathInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the OpenCode instance.",
          }),
        ),
        HttpApiEndpoint.get("vcs", InstancePaths.vcs, {
          query: WorkspaceRoutingQuery,
          success: described(Vcs.Info, "VCS info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsStatus", InstancePaths.vcsStatus, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Vcs.FileStatus), "VCS status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.status",
            summary: "Get VCS status",
            description: "Retrieve changed files in the current working tree without patches.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiff", InstancePaths.vcsDiff, {
          query: VcsDiffQuery,
          success: described(Schema.Array(Vcs.FileDiff), "VCS diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff",
            summary: "Get VCS diff",
            description: "Retrieve the current git diff for the working tree or against the default branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiffRaw", InstancePaths.vcsDiffRaw, {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-diff; charset=utf-8" })),
            "Raw VCS diff",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff.raw",
            summary: "Get raw VCS diff",
            description: "Retrieve a raw patch for current uncommitted changes.",
          }),
        ),
        HttpApiEndpoint.post("vcsApply", InstancePaths.vcsApply, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.ApplyInput,
          success: described(Vcs.ApplyResult, "VCS patch applied"),
          error: ApiVcsApplyError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.apply",
            summary: "Apply VCS patch",
            description: "Apply a raw patch to the current working tree.",
          }),
        ),
        HttpApiEndpoint.get("command", InstancePaths.command, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Command.Info), "List of commands"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "List commands",
            description: "Get a list of all available commands in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("agent", InstancePaths.agent, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Agent.Info), "List of agents"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agents",
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.post("agentGenerate", InstancePaths.agentGenerate, {
          query: WorkspaceRoutingQuery,
          payload: AgentGenerateInput,
          success: described(AgentGenerated, "Generated agent draft"),
          error: ApiAgentGenerateError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agentGenerate",
            summary: "Generate agent draft",
            description: "Generate an editable agent description and system prompt from a natural-language request.",
          }),
        ),
        HttpApiEndpoint.get("agentRuntime", InstancePaths.agentRuntime, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(AgentRuntime.Info), "Continuous agent runtimes"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agentRuntime",
            summary: "List continuous agents",
            description: "List live continuous-agent execution state for the current workspace.",
          }),
        ),
        HttpApiEndpoint.put("agentRuntimeUpdate", InstancePaths.agentRuntimeByName, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: AgentRuntimeUpdateInput,
          success: described(AgentRuntime.Info, "Continuous agent runtime"),
          error: ApiAgentRuntimeError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agentRuntimeUpdate",
            summary: "Start or stop continuous agent",
            description: "Start or stop the supervised continuous execution loop for an agent.",
          }),
        ),
        HttpApiEndpoint.put("agentUpdate", InstancePaths.agentByName, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: AgentWriteInput,
          success: described(Agent.Info, "Saved agent"),
          error: [ApiAgentMutationError, ApiAgentFileError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agentUpdate",
            summary: "Create or update agent",
            description: "Create or overwrite a user-defined AI agent in the global configuration directory.",
          }),
        ),
        HttpApiEndpoint.delete("agentDelete", InstancePaths.agentByName, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Agent deleted"),
          error: [ApiAgentMutationError, ApiAgentFileError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agentDelete",
            summary: "Delete agent",
            description: "Delete a user-defined AI agent from the global configuration directory.",
          }),
        ),
        HttpApiEndpoint.get("skill", InstancePaths.skill, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Skill.Info), "List of skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "List skills",
            description: "Get a list of all available skills in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("lsp", InstancePaths.lsp, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(LSP.Status), "LSP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.status",
            summary: "Get LSP status",
            description: "Get LSP server status",
          }),
        ),
        HttpApiEndpoint.get("formatter", InstancePaths.formatter, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Format.Status), "Formatter status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "formatter.status",
            summary: "Get formatter status",
            description: "Get formatter status",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "instance",
          description: "Experimental HttpApi instance read routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
