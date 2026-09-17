export * as WebVideoStatus from "./status"

import { WebVideoError, type ErrorKind, type Phase } from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const CONTENT_POLICY = /policy|nsfw|safety|inappropriate|moderation|flagged/i

/** Parses the `POST /api/generate-video` response (documented: runId, status, model, cost). */
export function parseCreated(raw: unknown) {
  const data = isRecord(raw) ? raw : {}
  const runId = typeof data.runId === "string" ? data.runId : typeof data.id === "string" ? data.id : undefined
  if (!runId) throw new WebVideoError("generation_failed", "NanoGPT did not return a run id for this generation.")
  return {
    runId,
    status: typeof data.status === "string" ? data.status : "pending",
    model: typeof data.model === "string" ? data.model : undefined,
    cost: number(data.cost),
  }
}

const PHASES: Record<string, Phase> = {
  pending: "queued",
  queued: "queued",
  in_queue: "queued",
  processing: "processing",
  in_progress: "processing",
  running: "processing",
  generating: "generating",
  delivering: "finishing",
  finishing: "finishing",
  uploading: "finishing",
  completed: "completed",
  succeeded: "completed",
  success: "completed",
  failed: "failed",
  error: "failed",
  cancelled: "failed",
  canceled: "failed",
}

export type Status = {
  phase: Phase
  url?: string
  cost?: number
  error?: { kind: ErrorKind; message: string }
}

function message(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (isRecord(value)) return message(value.message)
  return
}

/**
 * Parses `GET /api/video/status?requestId=` (documented: data.status,
 * data.output.video.url, data.cost, data.error / data.userFriendlyError).
 * Unknown intermediate states keep polling as "processing".
 */
export function parseStatus(raw: unknown): Status {
  const root = isRecord(raw) ? raw : {}
  const data = isRecord(root.data) ? root.data : root
  const phase = PHASES[String(data.status ?? "").toLowerCase()] ?? "processing"
  const cost = number(data.cost)

  if (phase === "failed") {
    const text = message(data.userFriendlyError) ?? message(data.error) ?? "The video generation failed."
    const contentPolicy = data.isNSFWError === true || CONTENT_POLICY.test(text)
    return { phase, cost, error: { kind: contentPolicy ? "content_policy" : "generation_failed", message: text } }
  }

  if (phase === "completed") {
    const output = isRecord(data.output) ? data.output : undefined
    const video = output && isRecord(output.video) ? output.video : undefined
    const url = video && typeof video.url === "string" && /^https?:\/\//.test(video.url) ? video.url : undefined
    if (!url)
      return {
        phase: "failed",
        cost,
        error: { kind: "generation_failed", message: "The generation finished but no video URL was returned." },
      }
    return { phase, url, cost }
  }

  return { phase, cost }
}

/** Maps a non-2xx NanoGPT response to a user-facing error. */
export function classifyHttpError(status: number, body: unknown): { kind: ErrorKind; message: string } {
  const root = isRecord(body) ? body : {}
  const detail = message(root.error) ?? message(root.message) ?? message(root.userFriendlyError)
  if (status === 401 || status === 403)
    return {
      kind: "invalid_api_key",
      message: "NanoGPT rejected the API key. Check NANOGPT_API_KEY or the NanoGPT connection.",
    }
  if (status === 402)
    return { kind: "insufficient_balance", message: detail ?? "Your NanoGPT balance is too low for this generation." }
  if (status === 429)
    return { kind: "rate_limited", message: "NanoGPT rate limit reached. Wait a moment and try again." }
  if (detail && CONTENT_POLICY.test(detail)) return { kind: "content_policy", message: detail }
  if (detail && /model/i.test(detail) && /not found|invalid|unknown|unsupported|does not exist/i.test(detail))
    return { kind: "invalid_model", message: detail }
  if (status === 400 || status === 422)
    return { kind: "unsupported_setting", message: detail ?? "NanoGPT rejected one of the video settings." }
  if (status >= 500) return { kind: "provider_unavailable", message: detail ?? "NanoGPT is unavailable right now." }
  return { kind: "generation_failed", message: detail ?? `NanoGPT returned HTTP ${status}.` }
}

/** Removes secrets from any text that may reach the chat, logs or error messages. */
export function redact(text: string, secrets: Array<string | undefined>) {
  return secrets.reduce<string>(
    (result, secret) => (secret && secret.length >= 8 ? result.split(secret).join("[redacted]") : result),
    text,
  )
}
