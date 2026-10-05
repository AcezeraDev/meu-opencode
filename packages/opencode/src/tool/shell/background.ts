import { randomUUID } from "crypto"
import { createWriteStream } from "node:fs"
import path from "path"
import { Effect, Fiber, Scope, Stream } from "effect"
import type { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { BackgroundJob } from "@/background/job"
import type { Context } from "../tool"
import type { TaskPromptOps } from "../task"
import { TRUNCATION_DIR } from "../truncation-dir"

/** The job type of a background command, which shell_jobs lists. */
export const TYPE = "shell"
/** How long a background command is watched before its start returns, so one that fails at once says so then. */
export const FIRST_LOOK = 3_000
/** How much of a background command's latest output its report carries. */
const TAIL = 4_000
/** Matching lines arriving together are told as one report. */
const GATHER = "1500 millis"
/** Reports about watched lines before the watch stops, so a noisy log cannot flood the conversation. */
const WATCH_LIMIT = 10
const WATCH_LINES = 30
// Colors and cursor moves, which dev servers print and nobody reads in a log.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export interface Started {
  id: string
  log: string
  /** What it printed so far. */
  first: string
  /** Set when it ended within the first look: its exit and output, nothing told later. */
  ended?: string
}

/**
 * Starts commands that keep running, such as dev servers, as background jobs:
 * output goes to a log file, and the conversation is told, as a message of its
 * own, when one exits and, with `watch`, when its output says what was watched
 * for. The session's stop button cancels them with its other jobs
 * (`metadata.sessionId`), and stopping one ends everything it started.
 */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner
  const jobs = yield* BackgroundJob.Service
  const fs = yield* FSUtil.Service
  const scope = yield* Scope.Scope

  return Effect.fn("ShellBackground.start")(function* (
    input: {
      command: ChildProcess.Command
      title: string
      cwd: string
      watch?: string
      metadata?: Record<string, unknown>
    },
    ctx: Context,
  ) {
    const watch = input.watch ? new RegExp(input.watch, "i") : undefined
    const id = `shell_${randomUUID().slice(0, 8)}`
    const log = path.join(TRUNCATION_DIR, `${id}.log`)
    yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
    const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
    const tell = (body: string[]) =>
      ops
        ? ops
            .prompt({
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              parts: [{ type: "text", synthetic: true, text: report(id, input.title, log, body) }],
            })
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
        : Effect.void
    // Watching starts once the start has returned, since what it returns
    // already carries what the command printed first.
    const seen = { tail: "", partial: "", matched: [] as string[], told: 0, gathering: false, watching: false }
    const gather = Effect.sleep(GATHER).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          seen.gathering = false
          seen.told++
          return tell([
            `Lines matching /${input.watch}/:`,
            ...seen.matched.splice(0),
            ...(seen.told >= WATCH_LIMIT ? ["", "(No more matches will be reported; read the log for the rest.)"] : []),
          ])
        }),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.asVoid,
    )
    const read = (sink: ReturnType<typeof createWriteStream>, chunk: string) =>
      Effect.suspend(() => {
        const text = chunk.replace(ANSI, "")
        sink.write(text)
        seen.tail = (seen.tail + text).slice(-TAIL)
        const lines = (seen.partial + text).split(/\r?\n/)
        seen.partial = lines.pop() ?? ""
        if (!watch || !seen.watching || seen.told >= WATCH_LIMIT) return Effect.void
        const hits = lines.filter((line) => watch.test(line))
        if (hits.length === 0) return Effect.void
        seen.matched.push(...hits.slice(0, Math.max(0, WATCH_LINES - seen.matched.length)))
        if (seen.gathering) return Effect.void
        seen.gathering = true
        return gather
      })

    yield* jobs.start({
      id,
      type: TYPE,
      title: input.title,
      metadata: { ...input.metadata, sessionId: ctx.sessionID, command: input.title, cwd: input.cwd, log },
      run: Effect.scoped(
        Effect.gen(function* () {
          const sink = createWriteStream(log, { flags: "a" })
          yield* Effect.addFinalizer(() => Effect.promise(() => new Promise<void>((resolve) => sink.end(resolve))))
          const handle = yield* spawner.spawn(input.command)
          const reader = yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) => read(sink, chunk)).pipe(
            Effect.forkScoped,
          )
          const code = yield* handle.exitCode
          // A child left running by the command can hold the pipe open; what came by then is enough.
          yield* Fiber.join(reader).pipe(Effect.timeout("2 seconds"), Effect.ignore)
          return [`exit code: ${code}`, "", seen.tail.trim() || "(no output)"].join("\n")
        }),
      ),
    })

    const early = yield* jobs.wait({ id, timeout: FIRST_LOOK })
    if (!early.timedOut) {
      const ended =
        early.info?.output ?? ([early.info?.error, seen.tail.trim()].filter(Boolean).join("\n\n") || "(no output)")
      return { id, log, first: seen.tail.trim(), ended } satisfies Started
    }

    seen.watching = true
    yield* jobs.wait({ id }).pipe(
      Effect.flatMap((result) => {
        const job = result.info
        if (!job || job.status === "running" || job.status === "cancelled") return Effect.void
        return tell([
          job.status === "error" ? `It failed: ${job.error ?? "unknown error"}` : "It exited.",
          "",
          job.output ?? "",
        ])
      }),
      Effect.forkIn(scope, { startImmediately: true }),
    )
    return { id, log, first: seen.tail.trim() } satisfies Started
  })
})

function report(id: string, title: string, log: string, body: string[]) {
  return [`<background-shell id="${id}">`, `command: ${title}`, `log: ${log}`, "", ...body, "</background-shell>"].join(
    "\n",
  )
}

export * as ShellBackground from "./background"
