export * as WebVideoTypes from "./types"

export const PURPOSES = ["hero", "background", "scroll", "product", "abstract", "section"] as const
export type Purpose = (typeof PURPOSES)[number]

export const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const
export type AspectRatio = (typeof ASPECT_RATIOS)[number]

export const QUALITIES = ["draft", "standard", "high"] as const
export type Quality = (typeof QUALITIES)[number]

export const MOTIONS = ["subtle", "medium", "dynamic"] as const
export type Motion = (typeof MOTIONS)[number]

export const CAMERA_MOVEMENTS = ["static", "slow-pan", "slow-zoom", "orbit", "dolly", "custom"] as const
export type CameraMovement = (typeof CAMERA_MOVEMENTS)[number]

/**
 * Ready-made video styles. A preset carries its own choreography and settings,
 * so "make a video from this photo" already produces the look the user wants.
 */
export const PRESETS = ["none", "hero-3d", "turntable"] as const
export type Preset = (typeof PRESETS)[number]

export const DEFAULT_VIDEO_MODEL = "minimax-h3"

/**
 * What a caller (the agent tool or the settings UI) asks for. These are app-level
 * concepts: they are translated into real NanoGPT request fields only when the
 * selected model declares support for them.
 */
export type Options = {
  prompt: string
  preset?: Preset
  purpose?: Purpose
  model?: string
  duration?: number
  aspectRatio?: string
  resolution?: string
  fps?: number
  quality?: Quality
  motion?: Motion
  cameraMovement?: CameraMovement
  loopFriendly?: boolean
  scrollFriendly?: boolean
  generateAudio?: boolean
  negativePrompt?: string
  seed?: number
  inferenceSteps?: number
  numFrames?: number
  cameraFixed?: boolean
  cfgScale?: number
  proMode?: boolean
  includeText?: boolean
  /** Public https URL or data URL of the starting frame. */
  referenceImage?: string
}

/** Persisted defaults used when the agent omits an option. */
export type Defaults = {
  model: string
  preset: Preset
  purpose: Purpose
  duration: number
  aspectRatio: string
  quality: Quality
  resolution?: string
  fps?: number
  motion: Motion
  cameraMovement: CameraMovement
  loopFriendly: boolean
  scrollFriendly: boolean
  generateAudio: boolean
  /** Only generate from a photo (image-to-video); text-only requests are refused. */
  requireImage: boolean
}

export const DEFAULTS: Defaults = {
  model: DEFAULT_VIDEO_MODEL,
  preset: "none",
  purpose: "hero",
  duration: 8,
  aspectRatio: "16:9",
  quality: "standard",
  motion: "subtle",
  cameraMovement: "slow-pan",
  loopFriendly: true,
  scrollFriendly: true,
  generateAudio: false,
  requireImage: true,
}

export type Phase = "queued" | "processing" | "generating" | "finishing" | "completed" | "failed"

export type ErrorKind =
  | "missing_api_key"
  | "invalid_api_key"
  | "insufficient_balance"
  | "rate_limited"
  | "timeout"
  | "generation_failed"
  | "content_policy"
  | "network_error"
  | "provider_unavailable"
  | "invalid_model"
  | "unsupported_setting"
  | "invalid_attachment"
  | "missing_image"
  | "interrupted"

/** The settings that were actually resolved for a request (after capability filtering). */
export type Settings = {
  preset: Preset
  purpose: Purpose
  quality: Quality
  motion: Motion
  cameraMovement: CameraMovement
  loopFriendly: boolean
  scrollFriendly: boolean
  generateAudio: boolean
  includeText: boolean
  duration?: number
  aspectRatio?: string
  resolution?: string
  fps?: number
  seed?: number
  inferenceSteps?: number
  numFrames?: number
  cameraFixed?: boolean
  cfgScale?: number
  proMode?: boolean
  negativePrompt?: string
  /** Where the starting frame came from. The image itself is never persisted. */
  referenceImage?: "url" | "attachment"
}

/**
 * The structured "video part": stored as the tool part's metadata, so it is
 * persisted with the conversation by the existing message store. It only holds
 * the remote video URL, never the video bytes.
 */
export type Metadata = {
  kind: "web-video"
  provider: "nanogpt"
  runId?: string
  model: string
  modelName: string
  status: Phase
  url?: string
  prompt: string
  finalPrompt: string
  settings: Settings
  estimatedCost?: number
  cost?: number
  currency: "USD"
  createdAt: string
  completedAt?: string
  error?: { kind: ErrorKind; message: string }
  warnings: string[]
}

export class WebVideoError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message)
    this.name = "WebVideoError"
  }
}
