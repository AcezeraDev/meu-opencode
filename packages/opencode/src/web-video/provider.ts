export * as WebVideoProvider from "./provider"

import { parseCatalog, type Model } from "@opencode-ai/core/web-video/capabilities"
import { classifyHttpError, parseCreated, parseStatus, redact, type Status } from "@opencode-ai/core/web-video/status"
import { WebVideoError } from "@opencode-ai/core/web-video/types"
import { Effect } from "effect"
import type { Auth } from "@/auth"

export const BASE_URL = "https://nano-gpt.com/api"
/** The NanoGPT provider id used by opencode's provider connection flow. */
export const NANOGPT_PROVIDER_ID = "nano-gpt"

const CATALOG_TTL = 10 * 60 * 1000
const REQUEST_TIMEOUT = 60 * 1000

export interface VideoProvider {
  readonly id: "nanogpt"
  getModels(): Promise<Model[]>
  generate(body: Record<string, unknown>): Promise<ReturnType<typeof parseCreated>>
  getStatus(runId: string): Promise<Status>
}

export type Input = {
  /** Resolved on the server only. Never sent to the browser or written to messages. */
  apiKey: () => Promise<string | undefined>
  fetch?: typeof fetch
  baseUrl?: string
  now?: () => number
}

// The model catalog is public and identical for every key, so one cache is shared.
const catalogCache: { at: number; models: Model[] } = { at: 0, models: [] }

export function resetCatalogCache() {
  catalogCache.at = 0
  catalogCache.models = []
}

async function parseJson(text: string): Promise<unknown> {
  if (!text) return {}
  return Promise.resolve()
    .then(() => JSON.parse(text) as unknown)
    .catch(() => ({ message: text.slice(0, 500) }))
}

export function nanoGPT(input: Input): VideoProvider {
  const fetcher = input.fetch ?? fetch
  const baseUrl = input.baseUrl ?? BASE_URL
  const now = input.now ?? Date.now

  async function request(path: string, init: { method: "GET" | "POST"; body?: unknown; auth: boolean }) {
    const key = init.auth ? await input.apiKey() : undefined
    if (init.auth && !key)
      throw new WebVideoError(
        "missing_api_key",
        "No NanoGPT API key is configured. Set NANOGPT_API_KEY on the server or connect the NanoGPT provider.",
      )
    const response = await fetcher(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "x-api-key": key } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    }).catch((error: unknown) => {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      throw new WebVideoError(
        timedOut ? "timeout" : "network_error",
        timedOut ? "NanoGPT did not respond in time." : "Could not reach NanoGPT. Check the network connection.",
      )
    })
    const body = await parseJson(await response.text())
    if (!response.ok) {
      const error = classifyHttpError(response.status, body)
      throw new WebVideoError(error.kind, redact(error.message, [key]))
    }
    return body
  }

  return {
    id: "nanogpt",
    async getModels() {
      if (catalogCache.models.length > 0 && now() - catalogCache.at < CATALOG_TTL) return catalogCache.models
      const models = parseCatalog(await request("/v1/video-models?detailed=true", { method: "GET", auth: false }))
      catalogCache.at = now()
      catalogCache.models = models
      return models
    },
    async generate(body) {
      return parseCreated(await request("/generate-video", { method: "POST", body, auth: true }))
    },
    async getStatus(runId) {
      return parseStatus(
        await request(`/video/status?requestId=${encodeURIComponent(runId)}`, { method: "GET", auth: true }),
      )
    },
  }
}

/**
 * Server-side key lookup: `NANOGPT_API_KEY` first, then the key saved when the
 * NanoGPT provider was connected in opencode. The value never leaves the server.
 */
export const resolveApiKey = Effect.fn("WebVideoProvider.resolveApiKey")(function* (auth: Auth.Interface) {
  const fromEnv = process.env.NANOGPT_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const info = yield* auth.get(NANOGPT_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined))
  return info?.type === "api" ? info.key : undefined
})

/** Normalizes anything thrown by the provider into a WebVideoError without leaking secrets. */
export function toWebVideoError(error: unknown, secrets: Array<string | undefined>) {
  if (error instanceof WebVideoError) return new WebVideoError(error.kind, redact(error.message, secrets))
  return new WebVideoError("generation_failed", redact(error instanceof Error ? error.message : String(error), secrets))
}
