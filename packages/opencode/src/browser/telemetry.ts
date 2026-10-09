/**
 * Timings for Lynx Browser Interact, which compares where an agent's time goes:
 * the model, screenshots, reading the page, acting on it and waiting for it.
 *
 * Off unless `LYNX_TELEMETRY_SESSION` holds the session ID the site shows, and
 * off means nothing is wrapped at all. `LYNX_TELEMETRY_START` (epoch ms, the
 * report's `session.recordingOrigin`) aligns the spans to the site's clock, and
 * `LYNX_TELEMETRY_FILE` moves the trace from `~/Downloads/lynx-trace.json`.
 *
 * Only durations, token counts and image sizes are kept: never a prompt, a
 * reply, a URL, a typed value or anything the page says.
 */
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { AsyncLocalStorage } from "node:async_hooks"
import { writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { LynxTelemetry, type Metrics, type Phase, type SpanContext, type SpanMeta } from "./lynx-telemetry.mjs"

export const file = process.env["LYNX_TELEMETRY_FILE"] || path.join(os.homedir(), "Downloads", "lynx-trace.json")

const telemetry = create()

export const enabled = telemetry !== undefined

/**
 * The phase the current operation is in. An operation called from inside one
 * of the same phase (a snapshot retrying, a settle waiting for quiet) is part
 * of the outer span, not a second measurement of the same time.
 */
const current = new AsyncLocalStorage<Phase>()

let pending: ReturnType<typeof setTimeout> | undefined

/** Times `operation`, which runs once either way and keeps its result and its error. */
export function span<T>(meta: SpanMeta, operation: (context?: SpanContext) => T | PromiseLike<T>) {
  if (!telemetry || current.getStore() === meta.phase) return new Promise<T>((resolve) => resolve(operation()))
  const result = current.run(meta.phase, () => telemetry.span(meta, operation))
  result.then(save, save)
  return result
}

/**
 * Wraps methods of `target` (a prototype) in spans named after them, so every
 * caller is measured without each call site knowing. A screenshot's size is
 * recorded when the method returns the image's bytes.
 */
export function measure(target: object, phases: Record<string, Phase>) {
  if (!telemetry) return
  for (const [name, phase] of Object.entries(phases)) {
    const original: unknown = Reflect.get(target, name)
    if (typeof original !== "function") throw new Error(`Lynx telemetry: ${name} is not a method`)
    Reflect.set(target, name, function (this: unknown, ...args: unknown[]) {
      return span({ phase, proof: name }, async (context) => {
        const result: unknown = await original.apply(this, args)
        if (phase === "screenshot" && result instanceof Uint8Array) context?.setMetrics({ imageBytes: result.byteLength })
        return result
      })
    })
  }
}

/**
 * Times one provider turn, from the request to the stream's last part, with
 * the token counts the provider reported. A stream that fails, carries an
 * error part or is cancelled (the turn interrupted) ends the span as an error.
 */
export async function model<R extends { stream: ReadableStream<LanguageModelV3StreamPart> }>(
  start: () => PromiseLike<R>,
): Promise<R> {
  if (!telemetry) return start()
  const ended = resolvers<Metrics>()
  span({ phase: "model" }, async (context) => context?.setMetrics(await ended.promise)).catch(() => {})
  const result = await Promise.resolve(start()).catch((error: unknown) => {
    ended.reject(error)
    throw error
  })
  const reader = result.stream.getReader()
  const metrics: Metrics = {}
  const failures: unknown[] = []
  return {
    ...result,
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      async pull(controller) {
        const next = await reader.read().catch((error: unknown) => {
          ended.reject(error)
          throw error
        })
        if (next.done) {
          if (failures.length) ended.reject(failures[0])
          ended.resolve(metrics)
          controller.close()
          return
        }
        if (next.value.type === "finish") {
          const input = next.value.usage.inputTokens.total
          const output = next.value.usage.outputTokens.total
          if (count(input)) metrics.inputTokens = input
          if (count(output)) metrics.outputTokens = output
        }
        if (next.value.type === "error") failures.push(next.value.error)
        controller.enqueue(next.value)
      },
      cancel(reason) {
        ended.reject(reason ?? new Error("cancelled"))
        return reader.cancel(reason)
      },
    }),
  }
}

/** The trace so far, as the site imports it. */
export function trace() {
  return telemetry?.export()
}

function create() {
  const sessionId = process.env["LYNX_TELEMETRY_SESSION"]
  if (!sessionId) return
  const start = Number(process.env["LYNX_TELEMETRY_START"])
  const aligned = !!process.env["LYNX_TELEMETRY_START"] && Number.isFinite(start)
  // A mistyped variable must not take the browser down with it.
  try {
    const created = aligned
      ? new LynxTelemetry({ sessionId, sessionStartEpochMs: start, clockAlignment: "session-relative" })
      : new LynxTelemetry({ sessionId, clockAlignment: "durations-only" })
    process.once("exit", () => created.spans.length && writeFileSync(file, created.toJSON(), "utf8"))
    return created
  } catch (error) {
    process.stderr.write(`Lynx telemetry is off: ${error instanceof Error ? error.message : String(error)}\n`)
    return
  }
}

/** Writes the trace a second after the last span ends, so a burst of spans is one write. */
function save() {
  if (!telemetry || pending) return
  pending = setTimeout(() => {
    pending = undefined
    telemetry.save(file).catch((error: unknown) => process.stderr.write(`Lynx telemetry could not save: ${error}\n`))
  }, 1000)
  pending.unref?.()
}

function count(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function resolvers<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

export * as BrowserTelemetry from "./telemetry"
