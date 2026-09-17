export * as WebVideoCost from "./cost"

import type { Model } from "./capabilities"

export type CostInput = {
  /** Models priced per mode bill a photo start frame differently from text. */
  mode: "text_to_video" | "image_to_video"
  duration?: number
  resolution?: string
  audio: boolean
  numFrames?: number
}

/**
 * Pricing fields this estimator understands. Any other field could change the
 * price in a way we can't model, so its presence makes the estimate unavailable
 * rather than wrong. Reference/edit fields only apply to video inputs, which web
 * videos never send, so they are safe to ignore.
 */
const UNDERSTOOD = new Set([
  "currency",
  "per_second",
  "per_second_by_resolution",
  "per_duration",
  "unit",
  "per_video",
  "with_audio",
  "without_audio",
  "per_resolution",
  "frame_multiplier",
  "frame_threshold",
  "audio_multiplier",
  "minimum",
  "supported_durations",
  "default_duration",
  "min_duration",
  "max_duration",
  "default_resolution",
  "fixed_duration_seconds",
  "variant",
  "video_reference_per_second_by_resolution",
  "video_reference_billing",
  "video_edit_per_second_by_resolution",
  "video_edit_billing",
  "per_second_by_mode",
  "per_second_by_mode_and_resolution",
  "output_per_second",
  // Reference videos, extra reference images and LoRAs are never sent: the photo
  // goes out as the single start frame.
  "reference_video_input_per_second",
  "extra_reference_image",
  "included_reference_images",
  "lora",
])

function record(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function base(pricing: Record<string, unknown>, input: CostInput) {
  const seconds = input.duration ?? number(pricing.fixed_duration_seconds) ?? number(pricing.default_duration)

  const resolution =
    input.resolution ?? (typeof pricing.default_resolution === "string" ? pricing.default_resolution : undefined)
  const perSecondRate = (rate: number | undefined) =>
    rate === undefined || seconds === undefined ? undefined : rate * seconds

  const perSecond = number(pricing.per_second) ?? number(pricing.output_per_second)
  if (perSecond !== undefined) return perSecondRate(perSecond)

  const byResolution = record(pricing.per_second_by_resolution)
  if (byResolution) return perSecondRate(resolution ? number(byResolution[resolution]) : undefined)

  const byMode = record(pricing.per_second_by_mode)
  if (byMode) return perSecondRate(number(byMode[input.mode]))

  const byModeAndResolution = record(record(pricing.per_second_by_mode_and_resolution)?.[input.mode])
  if (pricing.per_second_by_mode_and_resolution !== undefined)
    return perSecondRate(resolution && byModeAndResolution ? number(byModeAndResolution[resolution]) : undefined)

  const perDuration = record(pricing.per_duration)
  if (perDuration) return seconds === undefined ? undefined : number(perDuration[String(seconds)])

  const perVideo = number(pricing.per_video)
  if (perVideo !== undefined) return perVideo

  if (pricing.with_audio !== undefined || pricing.without_audio !== undefined)
    return number(input.audio ? pricing.with_audio : pricing.without_audio)

  const perResolution = record(pricing.per_resolution)
  if (perResolution) {
    const price = input.resolution ? number(perResolution[input.resolution]) : undefined
    if (price === undefined) return
    const threshold = number(pricing.frame_threshold)
    const multiplier = number(pricing.frame_multiplier)
    const extraFrames = threshold !== undefined && input.numFrames !== undefined && input.numFrames > threshold
    return extraFrames && multiplier !== undefined ? price * multiplier : price
  }

  return
}

/** Estimated USD cost from the catalog pricing, or undefined when it can't be computed honestly. */
export function estimate(model: Model, input: CostInput) {
  const pricing = model.pricing
  if (!pricing) return
  if (Object.keys(pricing).some((key) => !UNDERSTOOD.has(key))) return
  const price = base(pricing, input)
  if (price === undefined) return
  const audioMultiplier = number(pricing.audio_multiplier)
  const withAudio = input.audio && audioMultiplier !== undefined ? price * audioMultiplier : price
  const minimum = number(pricing.minimum)
  return Math.round(Math.max(withAudio, minimum ?? 0) * 10000) / 10000
}
