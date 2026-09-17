export * as WebVideoCapabilities from "./capabilities"

export type ParameterOption = { value: string; label: string }

export type Parameter = {
  /** The real NanoGPT request field name for this model. */
  name: string
  type: string
  label?: string
  description?: string
  default?: unknown
  options?: ParameterOption[]
  min?: number
  max?: number
  step?: number
}

/**
 * App concepts mapped to the request field names models actually use. The
 * catalog is inconsistent (e.g. audio is `generateAudio`, `generate_audio`,
 * `enable_audio` or `sound`), so each concept lists every known spelling and the
 * first one a model declares wins.
 */
export const CONCEPTS = {
  duration: ["duration", "seconds"],
  resolution: ["resolution"],
  aspectRatio: ["aspect_ratio"],
  fps: ["frames_per_second", "fps"],
  seed: ["seed"],
  inferenceSteps: ["num_inference_steps"],
  numFrames: ["num_frames"],
  negativePrompt: ["negative_prompt"],
  cameraFixed: ["camera_fixed"],
  cfg: ["cfg_scale", "guidance_scale"],
  proMode: ["pro_mode"],
  audio: ["generateAudio", "generate_audio", "enable_audio", "sound"],
} as const

export type Concept = keyof typeof CONCEPTS

export type Model = {
  id: string
  name: string
  description?: string
  ownedBy?: string
  textToVideo: boolean
  imageToVideo: boolean
  audioGeneration: boolean
  pricing?: Record<string, unknown>
  params: Partial<Record<Concept, Parameter>>
  tags: string[]
}

const MAX_RANGE_OPTIONS = 60

/**
 * Some fields only apply to another mode and the catalog says so in the label
 * (MiniMax H3: "LoRA / Edit / Extend Resolution", "Generate Edit Audio").
 * Web videos never use those modes, and sending the field anyway can change the
 * output (a 480p LoRA resolution), so they are skipped like showWhen fields.
 */
const OTHER_MODE_LABEL = /\b(lora|edit|extend)\b/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Catalog option values are strings or numbers; anything else is ignored. */
function scalar(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseParameter(name: string, raw: unknown): Parameter | undefined {
  if (!isRecord(raw)) return
  // Conditional parameters only apply under another field's value, which we
  // can't evaluate generically; never send them rather than guess.
  if (raw.showWhen !== undefined) return
  if (typeof raw.label === "string" && OTHER_MODE_LABEL.test(raw.label)) return
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((option) =>
        isRecord(option) && scalar(option.value) !== undefined
          ? [{ value: scalar(option.value)!, label: scalar(option.label) ?? scalar(option.value)! }]
          : [],
      )
    : undefined
  return {
    name,
    type: typeof raw.type === "string" ? raw.type : "string",
    label: typeof raw.label === "string" ? raw.label : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    default: raw.default,
    options: options && options.length > 0 ? options : undefined,
    min: numberOrUndefined(raw.min),
    max: numberOrUndefined(raw.max),
    step: numberOrUndefined(raw.step),
  }
}

export function parseModel(raw: unknown): Model | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string") return
  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {}
  if (capabilities.video_generation === false) return
  // Web videos start from a prompt or an image; video-to-video tools
  // (upscalers, enhancers, editors) can't produce one on their own.
  if (capabilities.text_to_video !== true && capabilities.image_to_video !== true) return
  const declared =
    isRecord(raw.supported_parameters) && isRecord(raw.supported_parameters.parameters)
      ? raw.supported_parameters.parameters
      : {}
  const params: Partial<Record<Concept, Parameter>> = {}
  for (const concept of Object.keys(CONCEPTS) as Concept[]) {
    const name = CONCEPTS[concept].find((candidate) => declared[candidate] !== undefined)
    if (!name) continue
    const parameter = parseParameter(name, declared[name])
    if (parameter) params[concept] = parameter
  }
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    description: typeof raw.description === "string" ? raw.description : undefined,
    ownedBy: typeof raw.owned_by === "string" ? raw.owned_by : undefined,
    textToVideo: capabilities.text_to_video === true,
    imageToVideo: capabilities.image_to_video === true,
    audioGeneration: capabilities.audio_generation === true,
    pricing: isRecord(raw.pricing) ? raw.pricing : undefined,
    params,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [],
  }
}

/** Parses `GET /api/v1/video-models?detailed=true`. Unknown entries are skipped. */
export function parseCatalog(raw: unknown): Model[] {
  const list = isRecord(raw) && Array.isArray(raw.data) ? raw.data : Array.isArray(raw) ? raw : []
  return list.flatMap((entry) => {
    const model = parseModel(entry)
    return model ? [model] : []
  })
}

export function has(model: Model, concept: Concept) {
  return model.params[concept] !== undefined
}

function rangeOptions(parameter: Parameter) {
  if (parameter.min === undefined || parameter.max === undefined) return []
  const step = parameter.step && parameter.step > 0 ? parameter.step : 1
  const values: number[] = []
  for (let value = parameter.min; value <= parameter.max && values.length < MAX_RANGE_OPTIONS; value += step) {
    values.push(value)
  }
  return values
}

/** The string choices a select-like parameter really accepts. */
export function choices(model: Model, concept: Concept) {
  return model.params[concept]?.options?.map((option) => option.value) ?? []
}

/** Durations (seconds) the model accepts; empty when the model controls duration itself. */
export function durations(model: Model) {
  const parameter = model.params.duration
  if (!parameter) return []
  const fromOptions = (parameter.options ?? []).map((option) => Number(option.value)).filter(Number.isFinite)
  if (fromOptions.length > 0) return fromOptions
  const fromRange = rangeOptions(parameter)
  if (fromRange.length > 0) return fromRange
  const supported = model.pricing?.supported_durations
  if (Array.isArray(supported)) return supported.filter((value): value is number => typeof value === "number")
  return []
}

/** The fixed clip length when the model does not expose a duration control. */
export function fixedDuration(model: Model) {
  return numberOrUndefined(model.pricing?.fixed_duration_seconds) ?? numberOrUndefined(model.pricing?.default_duration)
}

/**
 * FPS control. `values` lists discrete numeric choices; when a model only
 * declares a free numeric field, `values` is empty and `min`/`max` come from the
 * catalog only (never inferred from free-text descriptions).
 */
export function fps(model: Model) {
  const parameter = model.params.fps
  if (!parameter) return
  const values = (parameter.options ?? []).map((option) => Number(option.value)).filter(Number.isFinite)
  return {
    values,
    min: parameter.min,
    max: parameter.max,
    default: Number.isFinite(Number(parameter.default)) ? Number(parameter.default) : undefined,
  }
}

/** Sort resolutions from smallest to largest ("480p" < "720p" < "1080p" < "2k" < "4k"). */
export function resolutionRank(value: string) {
  const lower = value.toLowerCase()
  const pixels = /^(\d+)p$/.exec(lower)
  if (pixels) return Number(pixels[1])
  const k = /^(\d+)k$/.exec(lower)
  if (k) return Number(k[1]) * 1000
  const size = /^(\d+)x(\d+)$/.exec(lower)
  if (size) return Math.min(Number(size[1]), Number(size[2]))
  return Number.MAX_SAFE_INTEGER
}

export function resolutions(model: Model) {
  return [...choices(model, "resolution")].sort((a, b) => resolutionRank(a) - resolutionRank(b))
}
