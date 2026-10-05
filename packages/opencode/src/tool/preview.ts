import fs from "fs/promises"
import net from "net"
import path from "path"
import { Effect, Exit, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { BackgroundJob } from "@/background/job"
import { InstanceState } from "@/effect/instance-state"
import { BrowserNavigateTool } from "./browser_navigate"
import { ShellBackground } from "./shell/background"
import { ShellID } from "./shell/id"
import * as Tool from "./tool"
import DESCRIPTION from "./preview.txt"

export const Parameters = Schema.Struct({
  name: Schema.optional(Schema.String).annotate({
    description: "The configuration to start, by its name in launch.json. Defaults to the first one.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: 'The page to open on the server, such as "/login". Defaults to "/".',
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  name?: string
  url?: string
  jobId?: string
  log?: string
  started?: boolean
}

/** Where a project describes its dev servers; the second is the same file other agents read. */
const LAUNCH_FILES = [".opencode/launch.json", ".claude/launch.json"]
/** How long a server has to start listening before the preview gives up on it. */
const READY_WAIT = 90_000

const Launch = Schema.Struct({
  configurations: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      runtimeExecutable: Schema.optional(Schema.String),
      runtimeArgs: Schema.optional(Schema.Array(Schema.String)),
      port: Schema.optional(Schema.Number),
      url: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
})
const decodeLaunch = Schema.decodeUnknownOption(Schema.fromJsonString(Launch))

const EXAMPLE = `{
  "version": "0.0.1",
  "configurations": [
    { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173 }
  ]
}`

export const PreviewTool = Tool.define(
  "preview",
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const startBackground = yield* ShellBackground.make
    const navigate = yield* BrowserNavigateTool

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const directory = (yield* InstanceState.context).directory
          const launch = yield* Effect.promise(() => readLaunch(directory))
          if (!launch) {
            return {
              title: "No launch.json",
              metadata: {},
              output: [
                `This project has no ${LAUNCH_FILES[0]} yet. Create it with the command that starts the dev server and its port, then call preview again:`,
                "",
                EXAMPLE,
                "",
                'Set "cwd" (relative to the project) when the server starts from a subfolder, "url" when it is not http://localhost:<port>, and leave out "runtimeExecutable" for a server that is started some other way, so preview only opens it.',
              ].join("\n"),
            }
          }
          const config = params.name
            ? launch.file.configurations.find((item) => item.name === params.name)
            : launch.file.configurations[0]
          const names = launch.file.configurations.map((item) => item.name).join(", ")
          if (!config) {
            return {
              title: params.name ?? "preview",
              metadata: {},
              output: `${launch.path} has no configuration named "${params.name}". It has: ${names || "none"}.`,
            }
          }
          const base = config.url ?? (config.port ? `http://localhost:${config.port}` : undefined)
          if (!base) {
            return {
              title: config.name,
              metadata: { name: config.name },
              output: `The configuration "${config.name}" in ${launch.path} needs a "port" or a "url".`,
            }
          }
          const url = new URL(params.path ?? "/", base).toString()
          const address = new URL(base)
          const port = Number(address.port || (address.protocol === "https:" ? 443 : 80))

          // The same server again, while it still runs, is reused, as is any server already listening.
          const running = (yield* jobs.list()).find(
            (job) => job.status === "running" && job.metadata?.preview === config.name,
          )
          const listening = running || (yield* Effect.promise(() => answers(address.hostname, port)))
          const started =
            listening || !config.runtimeExecutable
              ? undefined
              : yield* Effect.gen(function* () {
                  const line = [config.runtimeExecutable, ...(config.runtimeArgs ?? [])].join(" ")
                  yield* ctx.ask({
                    permission: ShellID.ToolID,
                    patterns: [line],
                    always: [`${config.runtimeExecutable} *`],
                    metadata: { command: line },
                  })
                  const cwd = path.resolve(directory, config.cwd ?? ".")
                  return yield* startBackground(
                    {
                      command: ChildProcess.make(config.runtimeExecutable!, [...(config.runtimeArgs ?? [])], {
                        cwd,
                        env: { ...process.env, ...config.env },
                        stdin: "ignore",
                        // npm, pnpm and the like are .cmd files on Windows, which only a shell runs.
                        shell: process.platform === "win32",
                        detached: process.platform !== "win32",
                      }),
                      title: line,
                      cwd,
                      watch: "error|failed|exception",
                      metadata: { preview: config.name, port },
                    },
                    ctx,
                  )
                })
          const job = started?.id ?? running?.id
          const log = started?.log ?? (typeof running?.metadata?.log === "string" ? running.metadata.log : undefined)
          const metadata = { name: config.name, url, jobId: job, log, started: started !== undefined }

          if (started?.ended !== undefined) {
            return {
              title: config.name,
              metadata,
              output: [`The dev server "${config.name}" stopped right after starting:`, "", started.ended].join("\n"),
            }
          }
          if (!listening && !config.runtimeExecutable) {
            return {
              title: config.name,
              metadata,
              output: `Nothing answers at ${base}, and "${config.name}" has no runtimeExecutable to start it with. Start the server, or add the command to ${launch.path}.`,
            }
          }
          if (!listening) {
            const ready = yield* waitReady(jobs, address.hostname, port, job!)
            if (!ready) {
              const tail = yield* Effect.promise(() => lastLines(log))
              return {
                title: config.name,
                metadata,
                output: [
                  `The dev server "${config.name}" did not start answering at ${base} within ${READY_WAIT / 1000} s.`,
                  `log: ${log}`,
                  "",
                  tail || "(no output)",
                ].join("\n"),
              }
            }
          }

          const header = [
            started
              ? `Started "${config.name}" in the background as ${job}; it answers at ${base}.`
              : running
                ? `"${config.name}" was already running as ${job}, at ${base}.`
                : `A server already answers at ${base}; it was not started here.`,
            ...(log ? [`log: ${log}`] : []),
            ...(started
              ? ["You will be told if it prints an error or exits. Stop it with shell_jobs when you are done."]
              : []),
            "After changing the front end, check the pages with site_check, and look again here.",
          ]
          const tool = yield* navigate.init()
          const opened = yield* tool.execute({ url }, ctx).pipe(Effect.exit)
          if (Exit.isFailure(opened)) {
            return {
              title: config.name,
              metadata,
              output: [...header, "", `It could not be opened in the browser here; open ${url} to see it.`].join("\n"),
            }
          }
          return {
            title: config.name,
            metadata,
            output: [...header, "", opened.value.output].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/** Waits until the server answers, giving up early if its job ended. */
const waitReady = Effect.fn("PreviewTool.waitReady")(function* (
  jobs: BackgroundJob.Interface,
  host: string,
  port: number,
  id: string,
) {
  const end = Date.now() + READY_WAIT
  while (Date.now() < end) {
    if (yield* Effect.promise(() => answers(host, port))) return true
    const job = yield* jobs.get(id)
    if (!job || job.status !== "running") return false
    yield* Effect.sleep("300 millis")
  }
  return false
})

async function readLaunch(directory: string) {
  const found = await Promise.all(
    LAUNCH_FILES.map(async (name) => {
      const file = path.join(directory, name)
      const text = await fs.readFile(file, "utf8").catch(() => undefined)
      return text === undefined ? undefined : { path: file, file: decodeLaunch(text) }
    }),
  )
  const first = found.find((item) => item !== undefined)
  if (!first) return undefined
  return Option.isSome(first.file)
    ? { path: first.path, file: first.file.value }
    : { path: first.path, file: { configurations: [] } }
}

/** Whether something accepts connections there, as a dev server does once it is up. */
function answers(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

async function lastLines(log: string | undefined) {
  if (!log) return ""
  const text = await fs.readFile(log, "utf8").catch(() => "")
  return text.trimEnd().split(/\r?\n/).slice(-40).join("\n")
}
