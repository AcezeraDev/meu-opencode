import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { WebVideoError } from "@opencode-ai/core/web-video/types"
import { nanoGPT, resetCatalogCache } from "@/web-video/provider"
import { WebVideoSettings } from "@/web-video/settings"

const KEY = "sk-nano-test-0123456789"

type Call = { url: string; init: RequestInit }

function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = []
  const queue = [...responses]
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const next = queue.shift()
    if (!next) throw new Error("unexpected request")
    return next()
  }) as typeof fetch
  return { calls, fetcher }
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(WebVideoError)
  return error as WebVideoError
}

function header(call: Call, name: string) {
  return new Headers(call.init.headers).get(name)
}

describe("NanoGPT video provider", () => {
  test("loads the public catalog without sending the api key and caches it", async () => {
    resetCatalogCache()
    const fake = fakeFetch([
      json(200, { object: "list", data: [{ id: "m", name: "M", capabilities: { text_to_video: true } }] }),
    ])
    const provider = nanoGPT({ apiKey: async () => KEY, fetch: fake.fetcher })
    expect((await provider.getModels()).map((model) => model.id)).toEqual(["m"])
    await provider.getModels()
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].url).toBe("https://nano-gpt.com/api/v1/video-models?detailed=true")
    expect(header(fake.calls[0], "x-api-key")).toBeNull()
  })

  test("creates a generation with the x-api-key header and a JSON body", async () => {
    const fake = fakeFetch([json(200, { runId: "vid_1", status: "pending", model: "m", cost: 0.24 })])
    const provider = nanoGPT({ apiKey: async () => KEY, fetch: fake.fetcher })
    const created = await provider.generate({ model: "m", prompt: "p", duration: "6" })
    expect(created).toEqual({ runId: "vid_1", status: "pending", model: "m", cost: 0.24 })
    expect(fake.calls[0].url).toBe("https://nano-gpt.com/api/generate-video")
    expect(fake.calls[0].init.method).toBe("POST")
    expect(header(fake.calls[0], "x-api-key")).toBe(KEY)
    expect(JSON.parse(String(fake.calls[0].init.body))).toEqual({ model: "m", prompt: "p", duration: "6" })
  })

  test("polls the documented status endpoint and reads the video url", async () => {
    const fake = fakeFetch([
      json(200, { data: { status: "COMPLETED", output: { video: { url: "https://cdn.example/v.mp4" } }, cost: 0.24 } }),
    ])
    const provider = nanoGPT({ apiKey: async () => KEY, fetch: fake.fetcher })
    expect(await provider.getStatus("vid_1")).toEqual({
      phase: "completed",
      url: "https://cdn.example/v.mp4",
      cost: 0.24,
    })
    expect(fake.calls[0].url).toBe("https://nano-gpt.com/api/video/status?requestId=vid_1")
  })

  test("fails fast without a key and never calls the API", async () => {
    const fake = fakeFetch([])
    const provider = nanoGPT({ apiKey: async () => undefined, fetch: fake.fetcher })
    expect((await rejection(provider.generate({ model: "m" }))).kind).toBe("missing_api_key")
    expect(fake.calls).toHaveLength(0)
  })

  test("maps 401, 402 and 429 to friendly error kinds", async () => {
    const fake = fakeFetch([json(401, {}), json(402, { error: { message: "Insufficient balance" } }), json(429, {})])
    const provider = nanoGPT({ apiKey: async () => KEY, fetch: fake.fetcher })
    expect((await rejection(provider.generate({ model: "m" }))).kind).toBe("invalid_api_key")
    expect((await rejection(provider.generate({ model: "m" }))).kind).toBe("insufficient_balance")
    expect((await rejection(provider.generate({ model: "m" }))).kind).toBe("rate_limited")
  })

  test("content policy rejections are reported as such", async () => {
    const fake = fakeFetch([json(400, { error: { message: "Prompt blocked by safety filter" } })])
    const provider = nanoGPT({ apiKey: async () => KEY, fetch: fake.fetcher })
    expect((await rejection(provider.generate({ model: "m" }))).kind).toBe("content_policy")
  })

  test("network failures become network_error", async () => {
    const fake = fakeFetch([
      () => {
        throw new TypeError("fetch failed")
      },
    ])
    const provider = nanoGPT({ apiKey: async () => KEY, fetch: fake.fetcher })
    expect((await rejection(provider.getStatus("vid_1"))).kind).toBe("network_error")
  })

  test("never leaks the api key through error messages", async () => {
    const fake = fakeFetch([json(500, { error: { message: `upstream rejected key ${KEY}` } })])
    const provider = nanoGPT({ apiKey: async () => KEY, fetch: fake.fetcher })
    const error = await rejection(provider.generate({ model: "m" }))
    expect(error.kind).toBe("provider_unavailable")
    expect(error.message).not.toContain(KEY)
    expect(error.message).toContain("[redacted]")
  })
})

describe("desktop compatibility", () => {
  // The desktop app runs this server on Node inside Electron, where Bun globals
  // don't exist ("Bun is not defined" crashed the Video settings with HTTP 500),
  // and tests run on Bun, so they wouldn't notice on their own.
  test("web video server code avoids Bun-only APIs", async () => {
    const root = path.join(import.meta.dir, "../../src")
    const files = ["web-video/provider.ts", "web-video/settings.ts", "tool/web-video.ts"]
    for (const file of files) {
      const source = await readFile(path.join(root, file), "utf-8")
      expect({ file, usesBun: /\bBun\./.test(source) }).toEqual({ file, usesBun: false })
    }
  })
})

describe("web video settings", () => {
  test("sanitizes untrusted input back to valid defaults", () => {
    const settings = WebVideoSettings.sanitize({
      model: "  wan-video-image-to-video ",
      purpose: "tiktok",
      duration: -3,
      quality: "high",
      fps: "24",
      generateAudio: "yes",
      requireImage: "no",
      preset: "cinematic-explosion",
    })
    expect(settings.model).toBe("wan-video-image-to-video")
    expect(settings.purpose).toBe("hero")
    expect(settings.duration).toBe(8)
    expect(settings.quality).toBe("high")
    expect(settings.fps).toBeUndefined()
    expect(settings.generateAudio).toBe(false)
    // Photos stay required unless explicitly switched off with a real boolean.
    expect(settings.requireImage).toBe(true)
    expect(settings.preset).toBe("none")
    expect(WebVideoSettings.sanitize({ preset: "hero-3d" }).preset).toBe("hero-3d")
    expect(WebVideoSettings.sanitize({ requireImage: false }).requireImage).toBe(false)
  })

  test("saving replaces the stored defaults so cleared fields stay cleared", async () => {
    await WebVideoSettings.save({ model: "lightricks/ltx-2.5/fast", fps: 25 })
    expect((await WebVideoSettings.load()).fps).toBe(25)
    await WebVideoSettings.save({ model: "lightricks-ltx-2-fast" })
    const saved = await WebVideoSettings.load()
    expect(saved.model).toBe("lightricks-ltx-2-fast")
    expect(saved.fps).toBeUndefined()
  })
})
