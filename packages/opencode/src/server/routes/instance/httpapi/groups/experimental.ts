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

// A week (or any span since `since`, in ms) of using the agent, for the weekly summary page.
export const UsageWeekQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  since: Schema.optional(Schema.String),
})
const UsageWeekModel = Schema.Struct({
  model: Schema.String,
  steps: Schema.Number,
  cost: Schema.Number,
  tools: Schema.Number,
  errors: Schema.Number,
})
const UsageWeek = Schema.Struct({
  since: Schema.Number,
  sessions: Schema.Number,
  steps: Schema.Number,
  cost: Schema.Number,
  modelMs: Schema.Number,
  toolMs: Schema.Number,
  browserMs: Schema.Number,
  tools: Schema.Number,
  errors: Schema.Number,
  browserActions: Schema.Number,
  notebook: Schema.Number,
  reliable: Schema.optional(Schema.Struct({ model: Schema.String, tools: Schema.Number, errors: Schema.Number })),
  models: Schema.Array(UsageWeekModel),
  topErrors: Schema.Array(Schema.Struct({ message: Schema.String, count: Schema.Number })),
  topSessions: Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.String, steps: Schema.Number, cost: Schema.Number }),
  ),
}).annotate({ identifier: "UsageWeek" })

// What the agent learned about the site that is open: notes and saved programs.
export const BrowserSiteQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  url: Schema.String,
})
export const BrowserSiteForgetQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  url: Schema.String,
  note: Schema.String,
})
const BrowserSiteInfo = Schema.Struct({
  host: Schema.String,
  notes: Schema.Array(Schema.Struct({ text: Schema.String, at: Schema.Number })),
  programs: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.String, runs: Schema.Number, failures: Schema.Number }),
  ),
}).annotate({ identifier: "BrowserSiteInfo" })

// The activities of the course open in the browser, and which are done.
const BrowserLessons = Schema.Struct({
  course: Schema.String,
  url: Schema.String,
  sections: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      lessons: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          url: Schema.String,
          done: Schema.Boolean,
          tracked: Schema.Boolean,
          kind: Schema.String,
        }),
      ),
    }),
  ),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "BrowserLessons" })

// The study notebook: explained answers the agent gave on pages, by subject.
const NotebookSubject = Schema.Struct({
  slug: Schema.String,
  subject: Schema.String,
  count: Schema.Number,
  updated: Schema.Number,
})
const NotebookEntry = Schema.Struct({
  time: Schema.Number,
  sessionID: Schema.String,
  place: Schema.String,
  activity: Schema.String,
  answer: Schema.String,
  why: Schema.String,
  url: Schema.String,
})
const NotebookPage = Schema.Struct({
  subject: Schema.String,
  entries: Schema.Array(NotebookEntry),
}).annotate({ identifier: "NotebookPage" })

// The posting queue: videos the social agent posts at the time the person chose.
const SocialNetwork = Schema.Literals(["instagram", "tiktok"])
const SocialModel = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })
const SocialPost = Schema.Struct({
  id: Schema.String,
  video: Schema.String,
  name: Schema.String,
  network: SocialNetwork,
  at: Schema.Number,
  notes: Schema.String,
  caption: Schema.optional(Schema.String),
  model: Schema.optional(SocialModel),
  status: Schema.Literals(["scheduled", "producing", "posted", "failed"]),
  sessionID: Schema.optional(Schema.String),
  started: Schema.optional(Schema.Number),
  frames: Schema.optional(Schema.Array(Schema.String)),
  duration: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  draft: Schema.optional(Schema.String),
  analysis: Schema.optional(Schema.String),
  prep: Schema.optional(
    Schema.Struct({
      sessionID: Schema.String,
      started: Schema.Number,
      status: Schema.Literals(["running", "done", "failed"]),
      error: Schema.optional(Schema.String),
    }),
  ),
  prepNow: Schema.optional(Schema.Boolean),
  /** On a claim: the caption to post, saved as a write_text reference so it is typed exactly. */
  captionRef: Schema.optional(Schema.String),
  posted: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  created: Schema.Number,
  updated: Schema.Number,
}).annotate({ identifier: "SocialPost" })
const SocialQueueResponse = Schema.Struct({
  directory: Schema.String,
  posts: Schema.Array(SocialPost),
  /** What the social-prep agent learned of each account, to reuse instead of reading the profile again. */
  profiles: Schema.Struct({
    instagram: Schema.optional(Schema.Struct({ summary: Schema.String, updated: Schema.Number })),
    tiktok: Schema.optional(Schema.Struct({ summary: Schema.String, updated: Schema.Number })),
  }),
}).annotate({ identifier: "SocialQueue" })
export const SocialAddPayload = Schema.Struct({
  source: Schema.String,
  networks: Schema.Array(SocialNetwork),
  at: Schema.Number,
  notes: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  model: Schema.optional(SocialModel),
  /** JPEG data URLs of stills the app took from the video. */
  frames: Schema.optional(Schema.Array(Schema.String)),
  duration: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
})
export const SocialEditPayload = Schema.Struct({
  at: Schema.optional(Schema.Number),
  notes: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  network: Schema.optional(SocialNetwork),
  status: Schema.optional(Schema.Literal("scheduled")),
  prepare: Schema.optional(Schema.Boolean),
})
export const SocialClaimPayload = Schema.Struct({ sessionID: Schema.String })
export const SocialReportPayload = Schema.Struct({
  status: Schema.Literals(["posted", "failed", "unprepared"]),
  reason: Schema.optional(Schema.String),
})

// The Roteia provider's card in settings. Only whether a key is set and where it
// comes from, never the key; `test` also asks Roteia whether it accepts it.
export const RoteiaStatusQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  test: Schema.optional(Schema.String),
})
const RoteiaStatus = Schema.Struct({
  configured: Schema.Boolean,
  source: Schema.optional(Schema.Literals(["api", "env", "config"])),
  models: Schema.Number,
  check: Schema.optional(
    Schema.Struct({
      ok: Schema.Boolean,
      status: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "RoteiaStatus" })

// The training dataset: turns the person rated Approved/Excellent, as JSONL in Downloads.
export const DatasetExportQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  min: Schema.optional(Schema.Literals(["approved", "excellent"])),
})
const DatasetExport = Schema.Struct({
  file: Schema.String,
  examples: Schema.Number,
  sessions: Schema.Number,
  rated: Schema.Number,
}).annotate({ identifier: "DatasetExport" })

// Local Ollama: whether it runs, what is installed, and what this machine can
// run. Read-only; nothing is downloaded from here.
const OllamaStatus = Schema.Struct({
  running: Schema.Boolean,
  host: Schema.String,
  version: Schema.optional(Schema.String),
  connected: Schema.Boolean,
  models: Schema.Array(
    Schema.Struct({ id: Schema.String, context: Schema.Number, tools: Schema.Boolean, vision: Schema.Boolean }),
  ),
  hardware: Schema.Struct({
    platform: Schema.String,
    cpu: Schema.String,
    threads: Schema.Number,
    ramGB: Schema.Number,
    freeDiskGB: Schema.optional(Schema.Number),
    gpus: Schema.Array(
      Schema.Struct({ name: Schema.String, vramGB: Schema.optional(Schema.Number), dedicated: Schema.Boolean }),
    ),
  }),
  recommendation: Schema.Struct({
    accelerator: Schema.String,
    budgetGB: Schema.Number,
    contextWindow: Schema.Number,
    coding: Schema.optional(Schema.String),
    fast: Schema.optional(Schema.String),
    vision: Schema.optional(Schema.String),
    fits: Schema.Array(
      Schema.Struct({
        tag: Schema.String,
        context: Schema.Number,
        needGB: Schema.Number,
        installed: Schema.Boolean,
        note: Schema.String,
      }),
    ),
    notes: Schema.Array(Schema.String),
  }),
}).annotate({ identifier: "OllamaStatus" })

// How long the request in progress should still take, from the person's own
// history and the agent's todo list. Times are in milliseconds.
export const UsageEtaQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: Schema.String,
})
const UsageEta = Schema.Struct({
  elapsed: Schema.Number,
  remaining: Schema.optional(Schema.Number),
  basis: Schema.optional(Schema.Literals(["plan", "history"])),
  /** How long requests with this model usually take. */
  typical: Schema.optional(Schema.Number),
  /** Past requests the figures come from. */
  runs: Schema.Number,
  todos: Schema.optional(Schema.Struct({ total: Schema.Number, done: Schema.Number })),
}).annotate({ identifier: "UsageEta" })

// The skills the person reaches for most, newest use first among equals, for one-click shortcuts.
const UsageSkills = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ name: Schema.String, count: Schema.Number, last: Schema.Number })),
}).annotate({ identifier: "UsageSkills" })

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

const BrowserTrailShot = Schema.Struct({ image: Schema.optional(Schema.String) }).annotate({
  identifier: "BrowserTrailShot",
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
  mode: Schema.optional(Schema.Literals(["process", "extension"])),
  browser: Schema.optional(Schema.String),
  headless: Schema.Boolean,
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  tabs: Schema.Array(BrowserTab),
  external: Schema.optional(Schema.String),
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
  Schema.Struct({ action: Schema.Literals(["back", "forward", "reload", "open_external"]) }),
  Schema.Struct({ action: Schema.Literal("new_tab"), url: Schema.optional(Schema.String) }),
  Schema.Struct({ action: Schema.Literals(["select_tab", "close_tab"]), tab: Schema.String }),
  Schema.Struct({ action: Schema.Literal("resize"), width: Schema.Number, height: Schema.Number }),
  Schema.Struct({ action: Schema.Literal("xray"), on: Schema.Boolean }),
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
  usageEta: "/experimental/usage/eta",
  usageSkills: "/experimental/usage/skills",
  usageWeek: "/experimental/usage/week",
  notebook: "/experimental/notebook",
  notebookSubject: "/experimental/notebook/:subject",
  social: "/experimental/social",
  socialPost: "/experimental/social/:id",
  socialClaim: "/experimental/social/:id/claim",
  socialReport: "/experimental/social/:id/report",
  socialPrepare: "/experimental/social/:id/prepare",
  roteiaStatus: "/experimental/roteia/status",
  ollamaStatus: "/experimental/ollama/status",
  datasetExport: "/experimental/dataset/export",
  webVideoSettings: "/experimental/web-video/settings",
  browserStatus: "/experimental/browser/status",
  browserFrame: "/experimental/browser/frame",
  browserTrail: "/experimental/browser/trail/:sessionID/:callID",
  browserStream: "/experimental/browser/stream",
  browserInput: "/experimental/browser/input",
  browserControl: "/experimental/browser/control",
  browserSite: "/experimental/browser/site",
  browserLessons: "/experimental/browser/lessons",
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
        HttpApiEndpoint.get("usageWeek", ExperimentalPaths.usageWeek, {
          query: UsageWeekQuery,
          success: described(UsageWeek, "A week of using the agent"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.usage.week",
            summary: "Get the weekly summary",
            description:
              "Sessions, time, spend, tool errors and the most reliable model since `since` (ms), across all sessions.",
          }),
        ),
        HttpApiEndpoint.get("browserSite", ExperimentalPaths.browserSite, {
          query: BrowserSiteQuery,
          success: described(Schema.optional(BrowserSiteInfo), "What the agent learned about a site"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.browser.site",
            summary: "Get what the agent learned about a site",
            description: "Notes and saved programs kept for the site of `url`; nothing for pages off the web.",
          }),
        ),
        HttpApiEndpoint.get("browserLessons", ExperimentalPaths.browserLessons, {
          query: WorkspaceRoutingQuery,
          success: described(BrowserLessons, "The activities of the course open in the browser"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.browser.lessons",
            summary: "List the course's activities",
            description:
              "Reads the course index of the page open in the browser (Moodle) and says which activities are done. Only reads; `error` says why nothing was read.",
          }),
        ),
        HttpApiEndpoint.delete("browserSiteForget", ExperimentalPaths.browserSite, {
          query: BrowserSiteForgetQuery,
          success: described(Schema.optional(BrowserSiteInfo), "The site after forgetting the note"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.browser.site.forget",
            summary: "Forget one note about a site",
            description: "Removes note number `note` (1-based) from the site of `url`.",
          }),
        ),
        HttpApiEndpoint.get("notebook", ExperimentalPaths.notebook, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(NotebookSubject), "Subjects in the study notebook"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.notebook.list",
            summary: "List the study notebook's subjects",
            description: "Subjects with explained answers the agent kept, most recent first.",
          }),
        ),
        HttpApiEndpoint.get("notebookSubject", ExperimentalPaths.notebookSubject, {
          params: { subject: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.optional(NotebookPage), "One subject's explained answers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.notebook.get",
            summary: "Get one subject of the study notebook",
            description: "The explained answers kept for one subject, oldest first.",
          }),
        ),
        HttpApiEndpoint.get("social", ExperimentalPaths.social, {
          query: WorkspaceRoutingQuery,
          success: described(SocialQueueResponse, "The posting queue"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.social.list",
            summary: "List the posting queue",
            description:
              "Videos waiting to be posted, being posted, posted or failed, by time; and the folder their sessions run in.",
          }),
        ),
        HttpApiEndpoint.post("socialAdd", ExperimentalPaths.social, {
          query: WorkspaceRoutingQuery,
          payload: SocialAddPayload,
          success: described(Schema.Array(SocialPost), "The posts queued, one per network"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.social.add",
            summary: "Queue a video to post",
            description: "Copies the video at `source` and queues one post per network for the time `at`.",
          }),
        ),
        HttpApiEndpoint.patch("socialEdit", ExperimentalPaths.socialPost, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SocialEditPayload,
          success: described(Schema.optional(SocialPost), "The post after the change"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.social.edit",
            summary: "Change a queued post",
            description:
              "Changes its time, notes, caption or network; `status: scheduled` retries a failed post and `prepare` asks for a new caption now. A post being made is left alone.",
          }),
        ),
        HttpApiEndpoint.delete("socialRemove", ExperimentalPaths.socialPost, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.optional(SocialPost), "The post removed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.social.remove",
            summary: "Remove a post from the queue",
            description: "Removes the post and its copy of the video.",
          }),
        ),
        HttpApiEndpoint.post("socialClaim", ExperimentalPaths.socialClaim, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SocialClaimPayload,
          success: described(Schema.optional(SocialPost), "The post, if it was due and free"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.social.claim",
            summary: "Start making a due post",
            description:
              "Marks a due post as being made by the session, once; nothing comes back if it was not due or already taken.",
          }),
        ),
        HttpApiEndpoint.post("socialPrepare", ExperimentalPaths.socialPrepare, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SocialClaimPayload,
          success: described(Schema.optional(SocialPost), "The post, if its caption was due to be prepared"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.social.prepare",
            summary: "Start preparing a post's caption",
            description:
              "Marks a post's caption as being written by the session, once, when it is ten minutes from its time or the person asked for it.",
          }),
        ),
        HttpApiEndpoint.post("socialReport", ExperimentalPaths.socialReport, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SocialReportPayload,
          success: described(Schema.optional(SocialPost), "The post after the report"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.social.report",
            summary: "Say how a post went",
            description:
              "For a session that ended without the agent reporting: marks the post posted or failed, or its caption as not prepared.",
          }),
        ),
        HttpApiEndpoint.get("roteiaStatus", ExperimentalPaths.roteiaStatus, {
          query: RoteiaStatusQuery,
          success: described(RoteiaStatus, "Whether Roteia is connected"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.roteia.status",
            summary: "Get Roteia status",
            description:
              "Whether a Roteia API key is configured, where it comes from and how many models it loaded; with `test`, whether Roteia accepts the key.",
          }),
        ),
        HttpApiEndpoint.post("datasetExport", ExperimentalPaths.datasetExport, {
          query: DatasetExportQuery,
          success: described(DatasetExport, "Where the dataset was written and how many examples it has"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.dataset.export",
            summary: "Export the training dataset",
            description:
              "Writes the turns rated Approved or Excellent (or only Excellent, with min=excellent) as chat JSONL to the Downloads folder.",
          }),
        ),
        HttpApiEndpoint.get("ollamaStatus", ExperimentalPaths.ollamaStatus, {
          query: WorkspaceRoutingQuery,
          success: described(OllamaStatus, "Local Ollama, its models and this machine"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.ollama.status",
            summary: "Get Ollama status",
            description:
              "Whether Ollama runs on this machine, its installed models, the CPU/RAM/GPU found, and which models fit them.",
          }),
        ),
        HttpApiEndpoint.get("usageEta", ExperimentalPaths.usageEta, {
          query: UsageEtaQuery,
          success: described(UsageEta, "Estimated time left for the request in progress"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.usage.eta",
            summary: "Estimate time left",
            description:
              "Estimate how long the session's request in progress will still take, from past requests and the agent's todo list.",
          }),
        ),
        HttpApiEndpoint.get("usageSkills", ExperimentalPaths.usageSkills, {
          query: WorkspaceRoutingQuery,
          success: described(UsageSkills, "The skills used most"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.usage.skills",
            summary: "Get the most used skills",
            description:
              "Skills run by the agent or attached to a message in the last 60 days, across all sessions, most used first.",
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
        HttpApiEndpoint.get("browserTrail", ExperimentalPaths.browserTrail, {
          params: { sessionID: Schema.String, callID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(BrowserTrailShot, "The picture of the page after one of the agent's browser steps"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.browser.trail",
            summary: "Get the picture after a browser step",
            description:
              "A small picture of the page as it was after the given browser tool call, for looking back over what the agent did. Empty when none was kept.",
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
              "Navigate, go back or forward, reload, open, switch and close tabs, or open the current page in your own browser, as from a browser toolbar. Starts the browser if needed.",
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
