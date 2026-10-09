/**
 * Run by telemetry.test.ts in its own process, with `LYNX_TELEMETRY_SESSION`
 * set before anything is imported: the switch is read once, at import, and
 * other test files in the same run import the browser with it off.
 */
import fs from "fs/promises"
import { BrowserTelemetry } from "../../src/browser/telemetry"
import { Tab } from "../../src/browser/tab"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const thrown = new Error("original")

const sync = await BrowserTelemetry.span({ phase: "action", proof: "sync", operationId: "sync" }, () => 7)
const async = await BrowserTelemetry.span({ phase: "wait", proof: "async", operationId: "async" }, async () => {
  await wait(20)
  return "done"
})
const rejected = await BrowserTelemetry.span({ phase: "action", proof: "rejects", operationId: "rejects" }, async () => {
  throw thrown
}).catch((error: unknown) => error)
const syncThrown = await BrowserTelemetry.span({ phase: "action", proof: "throws", operationId: "throws" }, () => {
  throw thrown
}).catch((error: unknown) => error)
await Promise.all([
  BrowserTelemetry.span({ phase: "observation", operationId: "parallel-a" }, () => wait(40)),
  BrowserTelemetry.span({ phase: "screenshot", operationId: "parallel-b" }, () => wait(40)),
])
// Same phase inside the same phase is one span; another phase inside is its own.
await BrowserTelemetry.span({ phase: "wait", operationId: "outer" }, async () => {
  await BrowserTelemetry.span({ phase: "wait", operationId: "inner-same" }, () => wait(5))
  await BrowserTelemetry.span({ phase: "observation", operationId: "inner-other" }, () => wait(5))
})

class Fake {
  async shoot() {
    await wait(5)
    return new Uint8Array(1234)
  }
  async act(): Promise<string> {
    throw thrown
  }
}
BrowserTelemetry.measure(Fake.prototype, { shoot: "screenshot", act: "action" })
const shot = await new Fake().shoot()
const measuredError = await new Fake().act().catch((error: unknown) => error)

const parts = (list: LanguageModelV3StreamPart[]) =>
  new ReadableStream<LanguageModelV3StreamPart>({
    async start(controller) {
      for (const part of list) {
        await wait(5)
        controller.enqueue(part)
      }
      controller.close()
    },
  })
const usage = {
  inputTokens: { total: 1500, noCache: 1500, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 42, text: 42, reasoning: undefined },
}
const finished = await BrowserTelemetry.model(async () => ({
  stream: parts([
    { type: "text-delta", id: "1", delta: "oi" },
    { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
  ]),
}))
const delivered: string[] = []
const finishedReader = finished.stream.getReader()
for (let next = await finishedReader.read(); !next.done; next = await finishedReader.read()) delivered.push(next.value.type)
const cancelled = await BrowserTelemetry.model(async () => ({
  stream: parts([{ type: "text-delta", id: "1", delta: "oi" }, { type: "text-delta", id: "1", delta: "!" }]),
}))
const reader = cancelled.stream.getReader()
await reader.read()
await reader.cancel("interrupted")
const failedStart = await BrowserTelemetry.model(async (): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }> => {
  throw thrown
}).catch((error: unknown) => error)
await wait(20)

const file = process.env["LYNX_TELEMETRY_FILE"]!
await wait(1200)

console.log(
  JSON.stringify({
    enabled: BrowserTelemetry.enabled,
    sync,
    async,
    rejectedIsOriginal: rejected === thrown,
    syncThrownIsOriginal: syncThrown === thrown,
    measuredErrorIsOriginal: measuredError === thrown,
    shotBytes: shot.byteLength,
    delivered,
    failedStartIsOriginal: failedStart === thrown,
    tabMeasured: Tab.prototype.click.toString().includes("span("),
    trace: BrowserTelemetry.trace(),
    saved: JSON.parse(await fs.readFile(file, "utf8")),
  }),
)
