export * as WebVideoOptions from "./options"

import { ASPECT_RATIOS, CAMERA_MOVEMENTS, MOTIONS, PRESETS, PURPOSES, QUALITIES, type Options } from "./types"

const ENUMS = {
  preset: PRESETS,
  purpose: PURPOSES,
  quality: QUALITIES,
  motion: MOTIONS,
  cameraMovement: CAMERA_MOVEMENTS,
  aspectRatio: ASPECT_RATIOS,
} as const

const STRINGS = ["model", "resolution", "negativePrompt", "referenceImage"] as const
const NUMBERS = ["duration", "fps", "seed", "inferenceSteps", "numFrames", "cfgScale"] as const
const BOOLEANS = ["loopFriendly", "scrollFriendly", "generateAudio", "cameraFixed", "proMode", "includeText"] as const

/** A call with this many 0 / "" / null values was filled in by the backend, not chosen. */
const PLACEHOLDER_CALL = 3

function isPlaceholder(value: unknown) {
  return value === null || value === 0 || (typeof value === "string" && value.trim() === "")
}

/**
 * Normalizes the options an agent sent. Some function-calling backends require
 * every field, so models fill the ones they don't need with placeholders: 0, "",
 * null, false or an enum's first value. A real call asked for a 2-second 480p
 * draft this way, overriding the style and saved defaults. Placeholders are
 * treated as unset; in a placeholder-filled call, false and first enum values
 * are too, since they can't be told apart from filler.
 */
export function clean(input: Record<string, unknown>): Options {
  const filled = Object.values(input).filter(isPlaceholder).length >= PLACEHOLDER_CALL
  const options: Options = { prompt: typeof input.prompt === "string" ? input.prompt.trim() : "" }

  for (const [key, allowed] of Object.entries(ENUMS) as Array<[keyof typeof ENUMS, readonly string[]]>) {
    const value = input[key]
    if (typeof value !== "string" || !allowed.includes(value)) continue
    if (filled && value === allowed[0]) continue
    Object.assign(options, { [key]: value })
  }
  for (const key of STRINGS) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) options[key] = value.trim()
  }
  for (const key of NUMBERS) {
    const value = input[key]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) options[key] = value
  }
  for (const key of BOOLEANS) {
    const value = input[key]
    if (typeof value !== "boolean") continue
    if (filled && value === false) continue
    options[key] = value
  }
  return options
}
