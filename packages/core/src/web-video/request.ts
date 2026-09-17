export * as WebVideoRequest from "./request"

import { choices, durations, fixedDuration, fps, resolutions, type Model, type Parameter } from "./capabilities"
import { estimate } from "./cost"
import { imageSize, nearestAspect } from "./image"
import { buildWebVideoPrompt, defaultNegativePrompt, presetStyle } from "./prompt"
import { WebVideoError, type Defaults, type Options, type Quality, type Settings } from "./types"

export type Built = {
  /** The exact JSON body for `POST /api/generate-video`. */
  body: Record<string, unknown>
  settings: Settings
  finalPrompt: string
  /** Requested options that were adjusted or dropped because the model doesn't support them. */
  warnings: string[]
  estimatedCost?: number
}

const MAX_DATA_URL_BYTES = 10 * 1024 * 1024

function coerce(parameter: Parameter, value: string | number | boolean) {
  if (parameter.type === "number" || parameter.type === "integer") return Number(value)
  if (parameter.type === "switch" || parameter.type === "boolean") return value === true || value === "true"
  return String(value)
}

function nearest(values: number[], target: number) {
  return values.reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best), values[0])
}

function inRange(parameter: Parameter, value: number) {
  if (parameter.min !== undefined && value < parameter.min) return false
  if (parameter.max !== undefined && value > parameter.max) return false
  return true
}

function numericDefault(parameter: Parameter) {
  const value = Number(parameter.default)
  return parameter.default !== undefined && Number.isFinite(value) ? value : undefined
}

/** Quality presets only ever choose among values the model really declares. */
function pickResolution(model: Model, quality: Quality, requested: string | undefined, warnings: string[]) {
  const list = resolutions(model)
  if (list.length === 0) {
    if (requested) warnings.push(`${model.name} controls resolution itself; "${requested}" was not sent.`)
    return
  }
  if (requested && list.includes(requested)) return requested
  if (requested) warnings.push(`${model.name} does not offer ${requested}; used the ${quality} preset instead.`)
  if (quality === "draft") return list[0]
  if (quality === "high") return list[list.length - 1]
  if (list.includes("720p")) return "720p"
  const fallback = model.params.resolution?.default
  return typeof fallback === "string" && list.includes(fallback) ? fallback : list[Math.floor((list.length - 1) / 2)]
}

function pickSteps(parameter: Parameter, quality: Quality, requested: number | undefined, warnings: string[]) {
  if (requested !== undefined) {
    if (inRange(parameter, requested)) return requested
    warnings.push(`Inference steps ${requested} is outside the model's range and was not sent.`)
    return
  }
  const options = (parameter.options ?? []).map((option) => Number(option.value)).filter(Number.isFinite)
  if (options.length > 0) {
    if (quality === "draft") return Math.min(...options)
    if (quality === "high") return Math.max(...options)
    return numericDefault(parameter) ?? options[0]
  }
  if (quality === "draft") return parameter.min ?? numericDefault(parameter)
  if (quality === "high") return parameter.max ?? numericDefault(parameter)
  return numericDefault(parameter)
}

function imageField(reference: string) {
  if (reference.startsWith("data:image/")) {
    if (reference.length > MAX_DATA_URL_BYTES)
      throw new WebVideoError("invalid_attachment", "The reference image is too large (max 10 MB).")
    return { imageDataUrl: reference }
  }
  if (reference.startsWith("https://")) return { imageUrl: reference }
  throw new WebVideoError("invalid_attachment", "The reference image must be a public https URL or an image data URL.")
}

/**
 * Translates app-level options into a NanoGPT request. Only fields the chosen
 * model declares in the catalog are ever added to the body; everything else is
 * either folded into the prompt (creative intent) or reported as a warning.
 */
export function build(
  model: Model,
  options: Options,
  defaults: Defaults,
  referenceSource?: "url" | "attachment",
): Built {
  const warnings: string[] = []
  const body: Record<string, unknown> = { model: model.id }

  const reference = options.referenceImage?.trim()
  if (!reference && defaults.requireImage)
    throw new WebVideoError(
      "missing_image",
      "Attach a photo to animate. Videos are generated from a photo (image-to-video); this can be turned off in Settings → Video.",
    )
  if (reference && !model.imageToVideo)
    throw new WebVideoError("unsupported_setting", `${model.name} does not support image-to-video.`)
  if (!reference && !model.textToVideo)
    throw new WebVideoError("unsupported_setting", `${model.name} needs a reference image (image-to-video only).`)
  if (reference) Object.assign(body, imageField(reference))

  const quality = options.quality ?? defaults.quality
  const includeText = options.includeText ?? false
  // Precedence: what the request asks for, then the preset's needs, then saved defaults.
  const preset = options.preset ?? defaults.preset
  const style = presetStyle(preset)?.defaults ?? {}
  const settings: Settings = {
    preset,
    purpose: options.purpose ?? style.purpose ?? defaults.purpose,
    quality,
    motion: options.motion ?? style.motion ?? defaults.motion,
    cameraMovement: options.cameraMovement ?? style.cameraMovement ?? defaults.cameraMovement,
    loopFriendly: options.loopFriendly ?? style.loopFriendly ?? defaults.loopFriendly,
    scrollFriendly: options.scrollFriendly ?? style.scrollFriendly ?? defaults.scrollFriendly,
    generateAudio: options.generateAudio ?? defaults.generateAudio,
    includeText,
    referenceImage: reference ? (referenceSource ?? "url") : undefined,
  }

  // Duration
  const durationParam = model.params.duration
  const allowedDurations = durations(model)
  const requestedDuration = options.duration ?? style.duration ?? defaults.duration
  if (durationParam && allowedDurations.length > 0) {
    const chosen = allowedDurations.includes(requestedDuration)
      ? requestedDuration
      : nearest(allowedDurations, requestedDuration)
    if (chosen !== requestedDuration && options.duration !== undefined)
      warnings.push(`${model.name} does not offer ${requestedDuration}s; used ${chosen}s.`)
    body[durationParam.name] = coerce(durationParam, chosen)
    settings.duration = chosen
  }
  if (!durationParam || allowedDurations.length === 0) {
    settings.duration = fixedDuration(model)
    if (options.duration !== undefined)
      warnings.push(`${model.name} controls clip length itself; duration was not sent.`)
  }

  // Aspect ratio. With a photo and no explicit request the video follows the
  // photo: the nearest ratio the model offers, or nothing when the model already
  // matches its input ("auto") or the photo's size can't be read (https URLs).
  const aspectParam = model.params.aspectRatio
  const aspectChoices = choices(model, "aspectRatio")
  const followPhoto = !!reference && options.aspectRatio === undefined
  const photoSize = reference && followPhoto && !aspectChoices.includes("auto") ? imageSize(reference) : undefined
  const photoAspect = photoSize ? nearestAspect(aspectChoices, photoSize) : undefined
  const requestedAspect = followPhoto ? photoAspect : (options.aspectRatio ?? defaults.aspectRatio)
  if (aspectParam && requestedAspect && aspectChoices.includes(requestedAspect)) {
    body[aspectParam.name] = coerce(aspectParam, requestedAspect)
    settings.aspectRatio = requestedAspect
  }
  if (aspectParam && requestedAspect && !aspectChoices.includes(requestedAspect) && options.aspectRatio !== undefined)
    warnings.push(`${model.name} does not offer ${requestedAspect}; the model default was used.`)
  if (!aspectParam && options.aspectRatio !== undefined)
    warnings.push(`${model.name} controls aspect ratio itself; ${options.aspectRatio} was not sent.`)

  // Resolution (explicit value wins; otherwise the quality preset picks a real option)
  const resolutionParam = model.params.resolution
  const resolution = pickResolution(model, quality, options.resolution ?? defaults.resolution, warnings)
  if (resolutionParam && resolution) {
    body[resolutionParam.name] = coerce(resolutionParam, resolution)
    settings.resolution = resolution
  }

  // FPS (only when the model exposes it; otherwise it's model-controlled)
  const fpsControl = fps(model)
  const fpsParam = model.params.fps
  const requestedFps = options.fps ?? defaults.fps
  if (fpsControl && fpsParam && requestedFps !== undefined) {
    const discrete = fpsControl.values.length > 0
    const chosen = discrete ? nearest(fpsControl.values, requestedFps) : requestedFps
    const accepted = discrete || inRange(fpsParam, chosen)
    if (!accepted) warnings.push(`${chosen} FPS is outside the model's range and was not sent.`)
    if (accepted && chosen !== requestedFps)
      warnings.push(`${model.name} does not offer ${requestedFps} FPS; used ${chosen}.`)
    if (accepted) {
      body[fpsParam.name] = coerce(fpsParam, chosen)
      settings.fps = chosen
    }
  }
  if (!fpsControl && options.fps !== undefined)
    warnings.push(`${model.name} controls frame rate itself; FPS was not sent.`)

  // Inference steps follow the quality preset when the model exposes them.
  if (model.params.inferenceSteps) {
    const steps = pickSteps(model.params.inferenceSteps, quality, options.inferenceSteps, warnings)
    if (steps !== undefined) {
      body[model.params.inferenceSteps.name] = coerce(model.params.inferenceSteps, steps)
      settings.inferenceSteps = steps
    }
  }

  if (model.params.numFrames && options.numFrames !== undefined) {
    const frames = (model.params.numFrames.options ?? []).map((option) => Number(option.value))
    const valid =
      frames.length > 0 ? frames.includes(options.numFrames) : inRange(model.params.numFrames, options.numFrames)
    if (valid) {
      body[model.params.numFrames.name] = coerce(model.params.numFrames, options.numFrames)
      settings.numFrames = options.numFrames
    }
    if (!valid) warnings.push(`${options.numFrames} frames is not accepted by ${model.name} and was not sent.`)
  }

  if (model.params.seed && options.seed !== undefined) {
    body[model.params.seed.name] = coerce(model.params.seed, options.seed)
    settings.seed = options.seed
  }

  // A static camera maps onto a real camera_fixed field when the model has one.
  const cameraFixed = options.cameraFixed ?? (settings.cameraMovement === "static" ? true : undefined)
  if (model.params.cameraFixed && cameraFixed !== undefined) {
    body[model.params.cameraFixed.name] = coerce(model.params.cameraFixed, cameraFixed)
    settings.cameraFixed = cameraFixed
  }

  if (model.params.cfg && options.cfgScale !== undefined) {
    if (inRange(model.params.cfg, options.cfgScale)) {
      body[model.params.cfg.name] = coerce(model.params.cfg, options.cfgScale)
      settings.cfgScale = options.cfgScale
    }
    if (!inRange(model.params.cfg, options.cfgScale))
      warnings.push(`CFG ${options.cfgScale} is outside the model's range and was not sent.`)
  }

  if (model.params.proMode && options.proMode !== undefined) {
    body[model.params.proMode.name] = coerce(model.params.proMode, options.proMode)
    settings.proMode = options.proMode
  }

  // Audio is off by default for web videos. When the model has a switch, send
  // the explicit value (several models default it to on and bill for it).
  if (model.params.audio) body[model.params.audio.name] = coerce(model.params.audio, settings.generateAudio)
  if (!model.params.audio && settings.generateAudio) {
    warnings.push(`${model.name} has no audio control; audio was not requested.`)
    settings.generateAudio = false
  }

  // Negative prompt: a real field when available, otherwise folded into the prompt.
  const userNegative = options.negativePrompt?.trim()
  const negativeParam = model.params.negativePrompt
  if (negativeParam) {
    const combined = [userNegative, defaultNegativePrompt(includeText, !!reference)].filter(Boolean).join(", ")
    const limited = negativeParam.max !== undefined ? combined.slice(0, negativeParam.max) : combined
    body[negativeParam.name] = limited
    settings.negativePrompt = limited
  }

  const finalPrompt = buildWebVideoPrompt(options.prompt, {
    purpose: settings.purpose,
    motion: settings.motion,
    cameraMovement: settings.cameraMovement,
    loopFriendly: settings.loopFriendly,
    scrollFriendly: settings.scrollFriendly,
    includeText,
    fromImage: !!reference,
    preset,
    avoid: negativeParam ? undefined : userNegative,
  })
  body.prompt = finalPrompt

  const framesParam = model.params.numFrames
  return {
    body,
    settings,
    finalPrompt,
    warnings,
    estimatedCost: estimate(model, {
      mode: reference ? "image_to_video" : "text_to_video",
      duration: settings.duration,
      resolution: settings.resolution,
      audio: settings.generateAudio,
      numFrames: settings.numFrames ?? (framesParam ? numericDefault(framesParam) : undefined),
    }),
  }
}
