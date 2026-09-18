import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
}).annotate({ identifier: "ExperimentalCapabilities" })

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)

// Model spend across every session, for the titlebar's daily readout. `since` is a
// millisecond timestamp chosen by the client, so "today" follows the user's timezone.
export const UsageSpendQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  since: Schema.optional(Schema.String),
})
const UsageSpend = Schema.Struct({
  total: Schema.Number,
  messages: Schema.Number,
}).annotate({ identifier: "UsageSpend" })

// Capability data comes from NanoGPT's catalog and is shaped by
// @opencode-ai/core/web-video; the API key itself is never part of any response.
const WebVideoCatalog = Schema.Struct({
  configured: Schema.Boolean,
  defaultModel: Schema.String,
  models: Schema.Array(Schema.Unknown),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "WebVideoCatalog" })
export const WebVideoDefaults = Schema.Record(Schema.String, Schema.Unknown).annotate({
  identifier: "WebVideoDefaults",
})

// What the live browser panel needs to draw itself. The frame is a data URL so
// the panel can render it directly; it is omitted when nothing is open.
const BrowserTab = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  title: Schema.String,
  active: Schema.Boolean,
}).annotate({ identifier: "BrowserTab" })
const BrowserStatus = Schema.Struct({
  running: Schema.Boolean,
  browser: Schema.optional(Schema.String),
  headless: Schema.Boolean,
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  tabs: Schema.Array(BrowserTab),
}).annotate({ identifier: "BrowserStatus" })
const BrowserFrame = Schema.Struct({
  running: Schema.Boolean,
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
}).annotate({ identifier: "BrowserFrame" })
// Input from the live view, in viewport CSS pixels, forwarded to the active tab.
export const BrowserInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("mouse"),
    action: Schema.Literals(["move", "down", "up"]),
    x: Schema.Number,
    y: Schema.Number,
    button: Schema.optional(Schema.Literals(["left", "middle", "right", "none"])),
    buttons: Schema.optional(Schema.Number),
    clickCount: Schema.optional(Schema.Number),
    modifiers: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("wheel"),
    x: Schema.Number,
    y: Schema.Number,
    deltaX: Schema.Number,
    deltaY: Schema.Number,
    modifiers: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    action: Schema.Literals(["down", "up"]),
    key: Schema.String,
    code: Schema.String,
    keyCode: Schema.Number,
    text: Schema.optional(Schema.String),
    modifiers: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
]).annotate({ identifier: "BrowserInput" })
export const BrowserCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("navigate"), url: Schema.String }),
  Schema.Struct({ action: Schema.Literals(["back", "forward", "reload"]) }),
  Schema.Struct({ action: Schema.Literal("new_tab"), url: Schema.optional(Schema.String) }),
  Schema.Struct({ action: Schema.Literals(["select_tab", "close_tab"]), tab: Schema.String }),
  Schema.Struct({ action: Schema.Literal("resize"), width: Schema.Number, height: Schema.Number }),
]).annotate({ identifier: "BrowserCommand" })
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

export const ExperimentalPaths = {
  capabilities: "/experimental/capabilities",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionBackground: "/experimental/session/:sessionID/background",
  resource: "/experimental/resource",
  webVideoModels: "/experimental/web-video/models",
  usageSpend: "/experimental/usage/spend",
  webVideoSettings: "/experimental/web-video/settings",
  browserStatus: "/experimental/browser/status",
  browserFrame: "/experimental/browser/frame",
  browserStream: "/experimental/browser/stream",
  browserInput: "/experimental/browser/input",
  browserControl: "/experimental/browser/control",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the OpenCode server.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
        HttpApiEndpoint.get("usageSpend", ExperimentalPaths.usageSpend, {
          query: UsageSpendQuery,
          success: described(UsageSpend, "Model spend since a time"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.usage.spend",
            summary: "Get model spend",
            description: "Sum the cost of assistant messages created since `since` (ms), across all sessions.",
          }),
        ),
        HttpApiEndpoint.get("webVideoModels", ExperimentalPaths.webVideoModels, {
          query: WorkspaceRoutingQuery,
          success: described(WebVideoCatalog, "NanoGPT video models with capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.webVideo.models",
            summary: "List web video models",
            description:
              "List NanoGPT video models with parsed capabilities, and whether a NanoGPT API key is configured on the server.",
          }),
        ),
        HttpApiEndpoint.get("webVideoSettings", ExperimentalPaths.webVideoSettings, {
          query: WorkspaceRoutingQuery,
          success: described(WebVideoDefaults, "Saved web video defaults"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.webVideo.settings",
            summary: "Get web video defaults",
            description: "Get the defaults the generate_web_video tool uses when options are omitted.",
          }),
        ),
        HttpApiEndpoint.put("webVideoSettingsUpdate", ExperimentalPaths.webVideoSettings, {
          query: WorkspaceRoutingQuery,
          payload: WebVideoDefaults,
          success: described(WebVideoDefaults, "Updated web video defaults"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.webVideo.settings.update",
            summary: "Update web video defaults",
            description: "Update the defaults the generate_web_video tool uses when options are omitted.",
          }),
        ),
        HttpApiEndpoint.get("browserStatus", ExperimentalPaths.browserStatus, {
          query: WorkspaceRoutingQuery,
          success: described(BrowserStatus, "State of the built-in browser"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.browser.status",
            summary: "Get browser status",
            description: "Report whether the built-in browser is running, and which pages it has open.",
          }),
        ),
        HttpApiEndpoint.get("browserFrame", ExperimentalPaths.browserFrame, {
          query: WorkspaceRoutingQuery,
          success: described(BrowserFrame, "Current frame of the built-in browser"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.browser.frame",
            summary: "Get the current browser frame",
            description:
              "Screenshot the active tab of the built-in browser, for the live panel. Never starts the browser.",
          }),
        ),
        HttpApiEndpoint.get("browserStream", ExperimentalPaths.browserStream, {
          query: WorkspaceRoutingQuery,
          success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.browser.stream",
            summary: "Stream the built-in browser",
            description:
              "Server-sent events with the browser's status, live frames of the active tab and what the agent is doing. The agent acts at a visible pace while this is open.",
          }),
        ),
        HttpApiEndpoint.post("browserInput", ExperimentalPaths.browserInput, {
          query: WorkspaceRoutingQuery,
          payload: BrowserInput,
          success: described(Schema.Boolean, "Input forwarded"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.browser.input",
            summary: "Send input to the browser",
            description: "Forward a mouse, wheel, key or text event from the live view to the active tab.",
          }),
        ),
        HttpApiEndpoint.post("browserControl", ExperimentalPaths.browserControl, {
          query: WorkspaceRoutingQuery,
          payload: BrowserCommand,
          success: described(BrowserStatus, "State of the built-in browser after the command"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.browser.control",
            summary: "Control the browser",
            description:
              "Navigate, go back or forward, reload, or open, switch and close tabs, as from a browser toolbar. Starts the browser if needed.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
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
