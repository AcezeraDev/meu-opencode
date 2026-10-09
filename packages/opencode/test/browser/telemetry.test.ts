import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { BrowserTelemetry } from "../../src/browser/telemetry"
import type { SpanRecord } from "../../src/browser/lynx-telemetry.mjs"

describe("Lynx telemetry", () => {
  test("is off without a session, and runs the operation untouched", async () => {
    expect(BrowserTelemetry.enabled).toBe(false)
    expect(BrowserTelemetry.trace()).toBeUndefined()
    expect(await BrowserTelemetry.span({ phase: "action" }, () => 3)).toBe(3)
  })

  test("records real spans when a session is set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-telemetry-"))
    const file = path.join(dir, "lynx-trace.json")
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "lynx-telemetry-run.ts")], {
      cwd: path.join(import.meta.dir, "..", ".."),
      env: { ...process.env, LYNX_TELEMETRY_SESSION: "IL-TEST-000000", LYNX_TELEMETRY_FILE: file },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(err).not.toContain("Lynx telemetry is off")
    expect(code).toBe(0)
    const result = JSON.parse(out.trim().split("\n").at(-1)!)
    const spans: SpanRecord[] = result.trace.spans
    const by = (id: string) => spans.find((item) => item.operationId === id)!

    expect(result.enabled).toBe(true)
    expect(result.trace.format).toBe("lynx-trace-v1")
    expect(result.trace.sessionId).toBe("IL-TEST-000000")
    expect(result.trace.clockAlignment).toBe("durations-only")

    // Sync and async results come back; errors are the original ones.
    expect(result.sync).toBe(7)
    expect(result.async).toBe("done")
    expect(result.rejectedIsOriginal).toBe(true)
    expect(result.syncThrownIsOriginal).toBe(true)
    expect(result.measuredErrorIsOriginal).toBe(true)
    expect(result.failedStartIsOriginal).toBe(true)
    expect(by("sync").status).toBe("ok")
    expect(by("async").endMs - by("async").startMs).toBeGreaterThanOrEqual(15)
    expect(by("rejects").status).toBe("error")
    expect(by("throws").status).toBe("error")

    // Parallel spans overlap rather than being laid end to end.
    const a = by("parallel-a")
    const b = by("parallel-b")
    expect(Math.max(a.startMs, b.startMs)).toBeLessThan(Math.min(a.endMs, b.endMs))

    expect(by("outer")).toBeDefined()
    expect(by("inner-same")).toBeUndefined()
    expect(by("inner-other")).toBeDefined()

    const shoot = spans.find((item) => item.proof === "shoot")!
    expect(shoot.phase).toBe("screenshot")
    expect(shoot.imageBytes).toBe(1234)
    expect(result.shotBytes).toBe(1234)
    expect(spans.find((item) => item.proof === "act")!.status).toBe("error")

    // Every part reaches the caller; the turn's span carries its token counts.
    expect(result.delivered).toEqual(["text-delta", "finish"])
    const models = spans.filter((item) => item.phase === "model")
    expect(models.map((item) => item.status)).toEqual(["ok", "error", "error"])
    expect(models[0].inputTokens).toBe(1500)
    expect(models[0].outputTokens).toBe(42)

    // Every method in the tab's table exists and is wrapped.
    expect(result.tabMeasured).toBe(true)

    // Nothing from the page or the prompt is in the trace.
    expect(Object.keys(spans[0]).sort()).toEqual(["endMs", "id", "operationId", "phase", "proof", "startMs", "status"])
    expect(result.saved).toEqual(result.trace)
    await fs.rm(dir, { recursive: true, force: true })
  }, 60000)
})
