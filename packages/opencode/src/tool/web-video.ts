import path from "path"
import { fileURLToPath } from "url"
import { Effect, Schema } from "effect"
import { WebVideoOptions } from "@opencode-ai/core/web-video/options"
import { build } from "@opencode-ai/core/web-video/request"
import {
  ASPECT_RATIOS,
  CAMERA_MOVEMENTS,
  MOTIONS,
  PRESETS,
  PURPOSES,
  QUALITIES,
  WebVideoError,
  type Metadata,
  type Phase,
} from "@opencode-ai/core/web-video/types"
import { Auth } from "@/auth"
import { Filesystem } from "@/util/filesystem"
import { nanoGPT, resolveApiKey, toWebVideoError, type VideoProvider } from "@/web-video/provider"
import { WebVideoSettings } from "@/web-video/settings"
import * as Tool from "./tool"
import DESCRIPTION from "./web-video.txt"

export const POLL_INTERVAL = "5 seconds"
const POLL_TIMEOUT_MS = 20 * 60 * 1000
/** Transient polling failures tolerated before giving up. */
const MAX_POLL_FAILURES = 5
const TRANSIENT = new Set(["network_error", "timeout", "rate_limited", "provider_unavailable"])

const description = (text: string) => ({ description: text })

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate(description("What the video should show, in the user's own terms.")),
  preset: Schema.optional(Schema.NullOr(Schema.Literals(PRESETS))).annotate(
    description(
      'Ready-made style: "hero-3d" (360-degree turn plus a reveal moment, loops) or "turntable" (clean 360-degree turn). Omit to use the saved style.',
    ),
  ),
  purpose: Schema.optional(Schema.NullOr(Schema.Literals(PURPOSES))).annotate(
    description("Where the video will be used on the site."),
  ),
  model: Schema.optional(Schema.NullOr(Schema.String)).annotate(
    description("NanoGPT video model id. Omit to use the saved default."),
  ),
  duration: Schema.optional(Schema.NullOr(Schema.Number)).annotate(description("Clip length in seconds.")),
  aspectRatio: Schema.optional(Schema.NullOr(Schema.Literals(ASPECT_RATIOS))).annotate(
    description("Frame aspect ratio."),
  ),
  resolution: Schema.optional(Schema.NullOr(Schema.String)).annotate(
    description('Output resolution such as "480p", "720p" or "1080p".'),
  ),
  fps: Schema.optional(Schema.NullOr(Schema.Number)).annotate(
    description("Frames per second, when the model supports it."),
  ),
  quality: Schema.optional(Schema.NullOr(Schema.Literals(QUALITIES))).annotate(description("Quality preset.")),
  motion: Schema.optional(Schema.NullOr(Schema.Literals(MOTIONS))).annotate(description("Amount of motion.")),
  cameraMovement: Schema.optional(Schema.NullOr(Schema.Literals(CAMERA_MOVEMENTS))).annotate(
    description("Camera movement."),
  ),
  loopFriendly: Schema.optional(Schema.NullOr(Schema.Boolean)).annotate(
    description("Guide the model toward a seamless loop."),
  ),
  scrollFriendly: Schema.optional(Schema.NullOr(Schema.Boolean)).annotate(
    description("Continuous, cut-free motion suitable for scroll-scrubbed playback."),
  ),
  generateAudio: Schema.optional(Schema.NullOr(Schema.Boolean)).annotate(
    description("Generate audio. Off unless the user asks."),
  ),
  negativePrompt: Schema.optional(Schema.NullOr(Schema.String)).annotate(description("Things to avoid in the video.")),
  seed: Schema.optional(Schema.NullOr(Schema.Number)).annotate(description("Seed for reproducible results.")),
  inferenceSteps: Schema.optional(Schema.NullOr(Schema.Number)).annotate(
    description("Inference steps, when supported."),
  ),
  numFrames: Schema.optional(Schema.NullOr(Schema.Number)).annotate(description("Number of frames, when supported.")),
  cameraFixed: Schema.optional(Schema.NullOr(Schema.Boolean)).annotate(description("Lock the camera, when supported.")),
  cfgScale: Schema.optional(Schema.NullOr(Schema.Number)).annotate(
    description("CFG / guidance scale, when supported."),
  ),
  proMode: Schema.optional(Schema.NullOr(Schema.Boolean)).annotate(description("Pro mode, when supported.")),
  includeText: Schema.optional(Schema.NullOr(Schema.Boolean)).annotate(
    description("Allow text in the video. Only when the user explicitly asks for text."),
  ),
  referenceImage: Schema.optional(Schema.NullOr(Schema.String)).annotate(
    description(
      'Photo to animate. Omit to use the latest image the user attached; "attachment" forces that, or pass a public https image URL.',
    ),
  ),
})

type Params = Schema.Schema.Type<typeof Parameters>

const PHASE_LABEL: Record<Phase, string> = {
  queued: "queued",
  processing: "processing",
  generating: "generating",
  finishing: "finishing",
  completed: "completed",
  failed: "failed",
}

function settle<A>(promise: () => Promise<A>, secrets: Array<string | undefined>) {
  return Effect.promise(() =>
    promise().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: toWebVideoError(error, secrets) }),
    ),
  )
}

/**
 * The starting frame. When photos are required and the agent didn't name one,
 * the latest image the user attached is used, so "make a video from this photo"
 * works without the agent having to pass anything.
 */
async function resolveReference(value: string | undefined, messages: Tool.Context["messages"], requireImage: boolean) {
  const reference = value?.trim() || (requireImage ? "attachment" : undefined)
  if (!reference) return
  if (reference.startsWith("https://")) return { value: reference, source: "url" as const }
  if (reference.startsWith("data:image/")) return { value: reference, source: "attachment" as const }
  if (reference !== "attachment")
    throw new WebVideoError("invalid_attachment", 'referenceImage must be "attachment" or a public https image URL.')

  const images = messages
    .filter((message) => message.info.role === "user")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<typeof part, { type: "file" }> => part.type === "file")
    .filter((part) => part.mime.startsWith("image/"))
  const image = images[images.length - 1]
  if (!image)
    throw new WebVideoError(
      "missing_image",
      "No photo was attached. Attach the photo to animate (e.g. the product shot) and ask again.",
    )
  if (image.url.startsWith("data:image/") || image.url.startsWith("https://"))
    return { value: image.url, source: "attachment" as const }
  if (!image.url.startsWith("file://"))
    throw new WebVideoError("invalid_attachment", "The attached image could not be read.")
  const file = fileURLToPath(image.url)
  if (!(await Filesystem.exists(file)))
    throw new WebVideoError("invalid_attachment", `The attached image ${path.basename(image.url)} no longer exists.`)
  const bytes = (await Filesystem.readBytes(file)).toString("base64")
  return { value: `data:${image.mime};base64,${bytes}`, source: "attachment" as const }
}

function summary(metadata: Metadata) {
  const parts = [
    metadata.modelName,
    metadata.settings.preset !== "none" ? metadata.settings.preset : undefined,
    metadata.settings.duration ? `${metadata.settings.duration}s` : undefined,
    metadata.settings.aspectRatio,
    metadata.settings.resolution,
    metadata.settings.fps ? `${metadata.settings.fps} fps` : undefined,
  ]
  return parts.filter(Boolean).join(" · ")
}

function result(metadata: Metadata): Tool.ExecuteResult<Metadata> {
  const title = `Web video · ${metadata.modelName}`
  if (metadata.status === "completed")
    return {
      title,
      metadata,
      output: [
        `Generated a web video (${summary(metadata)}).`,
        `URL: ${metadata.url}`,
        metadata.cost !== undefined ? `Cost: $${metadata.cost.toFixed(2)}` : undefined,
        ...metadata.warnings.map((warning) => `Note: ${warning}`),
        "The player is already shown to the user in the chat.",
      ]
        .filter(Boolean)
        .join("\n"),
    }
  return {
    title,
    metadata,
    output: [
      `Web video generation failed (${metadata.error?.kind ?? "generation_failed"}): ${metadata.error?.message ?? "unknown error"}`,
      metadata.runId ? `NanoGPT run id: ${metadata.runId}` : undefined,
      "Explain the problem to the user. Do not retry unless they ask.",
    ]
      .filter(Boolean)
      .join("\n"),
  }
}

export const WebVideoTool = Tool.define(
  "generate_web_video",
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (input: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Placeholder values (0, "", null) from strict function-calling backends mean "unset".
          const params = WebVideoOptions.clean(input)
          const key = yield* resolveApiKey(auth)
          const secrets = [key]
          const provider: VideoProvider = nanoGPT({ apiKey: async () => key })
          const defaults = yield* Effect.promise(() => WebVideoSettings.load())
          const createdAt = new Date().toISOString()
          const modelId = params.model?.trim() || defaults.model

          const base: Metadata = {
            kind: "web-video",
            provider: "nanogpt",
            model: modelId,
            modelName: modelId,
            status: "queued",
            prompt: params.prompt,
            finalPrompt: params.prompt,
            settings: {
              preset: params.preset ?? defaults.preset,
              purpose: params.purpose ?? defaults.purpose,
              quality: params.quality ?? defaults.quality,
              motion: params.motion ?? defaults.motion,
              cameraMovement: params.cameraMovement ?? defaults.cameraMovement,
              loopFriendly: params.loopFriendly ?? defaults.loopFriendly,
              scrollFriendly: params.scrollFriendly ?? defaults.scrollFriendly,
              generateAudio: params.generateAudio ?? defaults.generateAudio,
              includeText: params.includeText ?? false,
            },
            currency: "USD",
            createdAt,
            warnings: [],
          }
          const failed = (metadata: Metadata, error: WebVideoError) =>
            result({ ...metadata, status: "failed", error: { kind: error.kind, message: error.message } })

          if (!key)
            return failed(
              base,
              new WebVideoError(
                "missing_api_key",
                "No NanoGPT API key is configured. Set NANOGPT_API_KEY on the server or connect the NanoGPT provider.",
              ),
            )

          const models = yield* settle(() => provider.getModels(), secrets)
          if (!models.ok) return failed(base, models.error)
          const model = models.value.find((item) => item.id === modelId)
          if (!model)
            return failed(
              base,
              new WebVideoError("invalid_model", `The video model "${modelId}" is not available on NanoGPT.`),
            )

          const reference = yield* settle(
            () => resolveReference(params.referenceImage, ctx.messages, defaults.requireImage),
            secrets,
          )
          if (!reference.ok) return failed({ ...base, modelName: model.name }, reference.error)

          const built = yield* settle(
            async () =>
              build(model, { ...params, referenceImage: reference.value?.value }, defaults, reference.value?.source),
            secrets,
          )
          if (!built.ok) return failed({ ...base, modelName: model.name }, built.error)

          const prepared: Metadata = {
            ...base,
            modelName: model.name,
            finalPrompt: built.value.finalPrompt,
            settings: built.value.settings,
            estimatedCost: built.value.estimatedCost,
            warnings: built.value.warnings,
          }

          // Paid action: show the resolved settings and estimated cost before spending.
          yield* ctx.ask({
            permission: "generate_web_video",
            patterns: [model.id],
            always: [model.id],
            metadata: {
              model: model.name,
              prompt: params.prompt,
              settings: summary(prepared),
              estimatedCost:
                prepared.estimatedCost === undefined ? "unavailable" : `~$${prepared.estimatedCost.toFixed(2)}`,
            },
          })

          yield* ctx.metadata({ title: `Web video · ${model.name}`, metadata: prepared })

          const created = yield* settle(() => provider.generate(built.value.body), secrets)
          if (!created.ok) return failed(prepared, created.error)

          const started: Metadata = { ...prepared, runId: created.value.runId, cost: created.value.cost }
          yield* ctx.metadata({ title: `Web video · ${model.name}`, metadata: started })

          const deadline = Date.now() + POLL_TIMEOUT_MS
          const poll = (current: Metadata, failures: number): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
            Effect.gen(function* () {
              yield* Effect.sleep(POLL_INTERVAL)
              if (ctx.abort.aborted)
                return failed(
                  current,
                  new WebVideoError(
                    "interrupted",
                    `Stopped waiting. NanoGPT has no cancel endpoint, so run ${created.value.runId} may still finish and be billed.`,
                  ),
                )
              const status = yield* settle(() => provider.getStatus(created.value.runId), secrets)
              if (!status.ok && TRANSIENT.has(status.error.kind) && failures < MAX_POLL_FAILURES)
                return yield* Effect.suspend(() => poll(current, failures + 1))
              if (!status.ok) return failed(current, status.error)

              const next: Metadata = {
                ...current,
                status: status.value.phase,
                cost: status.value.cost ?? current.cost,
                url: status.value.url ?? current.url,
              }
              if (status.value.phase === "completed") return result({ ...next, completedAt: new Date().toISOString() })
              if (status.value.phase === "failed")
                return failed(
                  next,
                  new WebVideoError(
                    status.value.error?.kind ?? "generation_failed",
                    status.value.error?.message ?? "The video generation failed.",
                  ),
                )
              if (Date.now() > deadline)
                return failed(
                  next,
                  new WebVideoError(
                    "timeout",
                    `Generation did not finish within 20 minutes. NanoGPT run id: ${created.value.runId}.`,
                  ),
                )
              if (next.status !== current.status)
                yield* ctx.metadata({
                  title: `Web video · ${model.name} · ${PHASE_LABEL[next.status]}`,
                  metadata: next,
                })
              return yield* Effect.suspend(() => poll(next, 0))
            })

          return yield* poll(started, 0)
        }),
    }
  }),
)
