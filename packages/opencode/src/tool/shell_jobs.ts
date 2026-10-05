import fs from "fs/promises"
import { Effect, Schema } from "effect"
import { BackgroundJob } from "@/background/job"
import { ShellBackground } from "./shell/background"
import * as Tool from "./tool"
import DESCRIPTION from "./shell_jobs.txt"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "output", "stop"]).annotate({
    description: "list the background commands, show one's latest output, or stop one.",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "The job id, such as shell_1a2b3c4d. Needed for output and stop.",
  }),
  lines: Schema.optional(Schema.Number).annotate({
    description: "How many of the last lines output shows (default: 80).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  action: string
  id?: string
  status?: string
}

const LINES = 80

export const ShellJobsTool = Tool.define(
  "shell_jobs",
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const shells = (yield* jobs.list()).filter((job) => job.type === ShellBackground.TYPE)
          if (params.action === "list") {
            const now = Date.now()
            return {
              title: "Background commands",
              metadata: { action: params.action },
              output: shells.length
                ? shells
                    .map(
                      (job) =>
                        `${job.id}  ${job.status}  ${Math.round((now - job.started_at) / 1000)}s  ${job.title ?? ""}`,
                    )
                    .join("\n")
                : "No background commands.",
            }
          }
          const job = shells.find((item) => item.id === params.id)
          if (!job) {
            return {
              title: params.id ?? "",
              metadata: { action: params.action, id: params.id },
              output: `No background command ${params.id ?? "(no id given)"}. Use action "list" to see them.`,
            }
          }
          if (params.action === "stop") {
            const stopped = yield* jobs.cancel(job.id)
            return {
              title: job.title ?? job.id,
              metadata: { action: params.action, id: job.id, status: stopped?.status ?? job.status },
              output:
                job.status === "running" ? `Stopped ${job.id} (${job.title}).` : `${job.id} had already ${job.status}.`,
            }
          }
          const log = typeof job.metadata?.log === "string" ? job.metadata.log : ""
          const text = yield* Effect.promise(() => fs.readFile(log, "utf8").catch(() => ""))
          const all = text.trimEnd().split(/\r?\n/)
          const count = Math.max(1, params.lines ?? LINES)
          return {
            title: job.title ?? job.id,
            metadata: { action: params.action, id: job.id, status: job.status },
            output: [
              `${job.id}: ${job.status}${job.status === "running" ? "" : job.error ? ` (${job.error})` : ""}`,
              `command: ${job.title}`,
              `log: ${log}`,
              all.length > count ? `(last ${count} of ${all.length} lines)` : "",
              "",
              all.slice(-count).join("\n") || "(no output yet)",
            ].join("\n"),
          }
        }),
    }
  }),
)
