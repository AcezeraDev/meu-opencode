export * as WebVideoPrompt from "./prompt"

import type { CameraMovement, Motion, Options, Preset, Purpose } from "./types"

export type PromptOptions = {
  purpose: Purpose
  motion: Motion
  cameraMovement: CameraMovement
  loopFriendly: boolean
  scrollFriendly: boolean
  includeText: boolean
  /** Animating a reference photo (image-to-video) instead of generating from text. */
  fromImage?: boolean
  /** A ready-made style; its choreography replaces the generic motion traits. */
  preset?: Preset
  /** Folded into the prompt when the model has no negative_prompt field. */
  avoid?: string
}

const PURPOSE_LEAD: Record<Purpose, string> = {
  hero: "Premium cinematic website hero background",
  background: "Ambient animated website background",
  scroll: "Cinematic scroll-driven website sequence",
  product: "Premium product hero shot for a website",
  abstract: "Abstract motion background for a website",
  section: "Cinematic full-width website section video",
}

const MOTION: Record<Motion, string> = {
  subtle: "subtle continuous motion, slow calm pacing",
  medium: "smooth continuous motion, moderate pacing",
  dynamic: "dynamic yet fluid motion, energetic pacing without abrupt cuts",
}

const CAMERA: Record<CameraMovement, string | undefined> = {
  static: "locked-off static camera",
  "slow-pan": "slow smooth camera pan",
  "slow-zoom": "slow gentle push-in camera move",
  orbit: "slow orbiting camera move around the subject",
  dolly: "smooth cinematic dolly movement",
  // The user describes the move in their own words.
  custom: undefined,
}

const SCROLL = [
  "one continuous uninterrupted shot",
  "steady predictable camera path",
  "stable composition",
  "no cuts",
  "no sudden transitions",
  "beginning and end visually coherent",
  "suitable for scroll-controlled playback",
]

const LOOP = [
  "seamless continuous motion",
  "stable composition",
  "ending composition visually connects with the beginning",
  "no abrupt cuts",
  "no sudden scene changes",
]

// Framing leaves calm space for the page's own copy without mentioning
// overlays or content, which models render as fake UI and lettering.
const WEB = ["cinematic lighting", "high visual quality", "balanced composition with calm negative space"]

/**
 * Keeps baked-in text out without naming it. Video models tend to draw what a
 * prompt mentions even when negated ("no subtitles" produced garbled subtitles
 * in real LTX-2 runs), so the words "text", "subtitles", "logos" only ever go
 * to a model's negative_prompt field (see defaultNegativePrompt).
 */
export const CLEAN_FRAME = ["clean, uncluttered frame"]

/**
 * Image-to-video: the photo is the source of truth for what the subject is
 * (design, materials, colors, label artwork), while the requested action is
 * still free to move it: freezing its shape would stop a cap from opening.
 */
export const FROM_IMAGE = [
  "the subject keeps its exact design, materials, colors and label artwork from the reference photo",
  "existing label artwork stays sharp and legible",
  "rigid parts move realistically as solid objects",
  "lighting consistent with the photo",
]

type PresetStyle = {
  lead: (fromImage: boolean) => string
  /** Scene sentences in playback order; `details` is the product-specific part from the request. */
  scene: (details: string) => string[]
  traits: string[]
  /** Settings the style needs; explicit request options still win. */
  defaults: Pick<Options, "purpose" | "duration" | "motion" | "cameraMovement" | "loopFriendly" | "scrollFriendly">
}

const STUDIO =
  "The product floats centered in a clean, seamless studio that matches the photo's background, with a soft contact shadow."
const SMOOTH = "All motion is slow, smooth and continuous, with gentle ease-in and ease-out and no sudden changes."
const TURN = "The product turns a full 360 degrees around its vertical axis like a turntable, revealing every side."
const LOOP_BACK = "It ends fully assembled in exactly the starting pose from the photo, so the video loops seamlessly."
// Real runs let a removed cap drop to the floor and ended with the product standing
// upright, breaking the loop; keep detached parts airborne and bring them back.
const PARTS_RETURN = "Any part that comes off stays in the air close to the product and goes back into place before the end."
const RENDER = [
  "locked-off camera",
  "crisp focus",
  "soft diffused studio lighting with subtle reflections",
  "high-end commercial product render",
]

/**
 * Written for any product (a bottle, headphones, a mouse): the request only has
 * to name the product's own reveal moment, everything else comes from here.
 */
export const PRESET_STYLES: Record<Exclude<Preset, "none">, PresetStyle> = {
  "hero-3d": {
    lead: (fromImage) =>
      fromImage
        ? "Premium 3D product hero video for a website, animated from the reference photo"
        : "Premium 3D product hero video for a website",
    scene: (details) => [
      STUDIO,
      SMOOTH,
      TURN,
      details
        ? `Reveal moment: ${details}.`
        : "Midway it shows one elegant reveal of its key part, such as a cap or lid lifting off and hovering, then closes again.",
      PARTS_RETURN,
      LOOP_BACK,
    ],
    traits: RENDER,
    defaults: {
      purpose: "product",
      duration: 10,
      motion: "subtle",
      cameraMovement: "static",
      loopFriendly: true,
      scrollFriendly: true,
    },
  },
  turntable: {
    lead: (fromImage) =>
      fromImage
        ? "Clean 360-degree product turntable video for a website, animated from the reference photo"
        : "Clean 360-degree product turntable video for a website",
    scene: (details) => [
      STUDIO,
      SMOOTH,
      `${TURN} The turn keeps a constant, gentle speed.`,
      ...(details ? [`${details}.`] : []),
      LOOP_BACK,
    ],
    traits: RENDER,
    defaults: {
      purpose: "product",
      duration: 8,
      motion: "subtle",
      cameraMovement: "static",
      loopFriendly: true,
      scrollFriendly: true,
    },
  },
}

export function presetStyle(preset: Preset | undefined) {
  return preset && preset !== "none" ? PRESET_STYLES[preset] : undefined
}

/**
 * Wraps the user's description with the technical traits web videos need
 * (framing, pacing, continuity, no baked-in text). The user's own words are
 * kept verbatim; only production constraints are added around them.
 */
export function buildWebVideoPrompt(prompt: string, options: PromptOptions) {
  const subject = prompt.trim().replace(/[.\s]+$/, "")
  const style = presetStyle(options.preset)
  if (style) {
    const traits = [
      ...(options.fromImage ? FROM_IMAGE : []),
      ...style.traits,
      ...(options.includeText ? [] : CLEAN_FRAME),
    ]
    const avoid = options.avoid?.trim()
    return [
      `${style.lead(!!options.fromImage)}.`,
      ...style.scene(subject),
      `${[...new Set(traits)].join(", ")}.`,
      ...(avoid ? [`Avoid: ${avoid}.`] : []),
    ].join(" ")
  }
  const traits = [
    MOTION[options.motion],
    CAMERA[options.cameraMovement],
    ...(options.scrollFriendly ? SCROLL : []),
    ...(options.loopFriendly ? LOOP : []),
    ...(options.fromImage ? FROM_IMAGE : []),
    ...WEB,
    ...(options.includeText ? [] : CLEAN_FRAME),
  ].filter((trait): trait is string => !!trait)
  const unique = [...new Set(traits)]
  const avoid = options.avoid?.trim()
  const purpose = PURPOSE_LEAD[options.purpose]
  const lead = options.fromImage
    ? `Animate the reference photo into ${/^[aeiou]/i.test(purpose) ? "an" : "a"} ${purpose.toLowerCase()}`
    : purpose
  return [`${lead}: ${subject}.`, `${unique.join(", ")}.`, ...(avoid ? [`Avoid: ${avoid}.`] : [])].join(" ")
}

/** Default negative prompt for models that accept one. */
export function defaultNegativePrompt(includeText: boolean, fromImage = false) {
  const text = fromImage
    ? ["added text", "captions", "subtitles", "watermark", "distorted or unreadable labels", "garbled lettering"]
    : ["text", "typography", "logos", "subtitles", "watermark"]
  return [
    ...(includeText ? [] : text),
    ...(fromImage ? ["morphing", "deformed subject", "changed colors"] : []),
    "hard cuts",
    "flicker",
    "jitter",
  ].join(", ")
}
