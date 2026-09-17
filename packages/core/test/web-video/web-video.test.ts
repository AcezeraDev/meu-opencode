import { describe, expect, test } from "bun:test"
import { durations, fps, parseCatalog, resolutions, type Model } from "@opencode-ai/core/web-video/capabilities"
import { estimate } from "@opencode-ai/core/web-video/cost"
import { imageSize, nearestAspect } from "@opencode-ai/core/web-video/image"
import { clean } from "@opencode-ai/core/web-video/options"
import { buildWebVideoPrompt } from "@opencode-ai/core/web-video/prompt"
import { build } from "@opencode-ai/core/web-video/request"
import { classifyHttpError, parseCreated, parseStatus, redact } from "@opencode-ai/core/web-video/status"
import { DEFAULTS, WebVideoError, type ErrorKind } from "@opencode-ai/core/web-video/types"
import catalog from "./fixtures/video-models.json"

const models = parseCatalog(catalog)

function model(id: string): Model {
  const found = models.find((item) => item.id === id)
  if (!found) throw new Error(`fixture is missing ${id}`)
  return found
}

const ltx = model("lightricks-ltx-2-fast")
const wan = model("wan-video-image-to-video")
const seedance = model("bytedance/seedance-2.5")
const kling = model("kling-v26-pro")
const veo = model("veo3-video")
const minimax = model("minimax/h3-max/multi-angle/image-to-video")
const gemini = model("google/gemini-omni-flash/v1.1")
const h3 = model("minimax-h3")
const IMAGE = "data:image/png;base64,iVBORw0KGgo="
// Text-only requests need the photo requirement turned off.
const T2V = { ...DEFAULTS, requireImage: false }

function dataUrl(mime: string, bytes: number[]) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

// PNG signature + IHDR for a 720x950 portrait photo (same shape as a product shot).
const PORTRAIT_PNG = dataUrl(
  "image/png",
  [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x02, 0xd0, 0, 0, 0x03,
    0xb6, 8, 6, 0, 0, 0,
  ],
)
// JPEG SOI + APP0 (16 bytes) + SOF0 for 1920x1080.
const LANDSCAPE_JPEG = dataUrl(
  "image/jpeg",
  [
    0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x04,
    0x38, 0x07, 0x80, 3,
  ],
)

function expectKind(fn: () => unknown, kind: ErrorKind) {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(WebVideoError)
    expect((error as WebVideoError).kind).toBe(kind)
    return
  }
  throw new Error(`expected WebVideoError(${kind})`)
}

describe("capabilities", () => {
  test("parses the real catalog shape", () => {
    expect(models).toHaveLength(8)
  })

  test("LTX-2 Fast exposes duration and audio but not fps, resolution or aspect ratio", () => {
    expect(durations(ltx)).toEqual([6, 8, 10, 12, 14, 16, 18, 20])
    expect(ltx.params.audio?.name).toBe("generateAudio")
    expect(fps(ltx)).toBeUndefined()
    expect(resolutions(ltx)).toEqual([])
    expect(ltx.params.aspectRatio).toBeUndefined()
    expect(ltx.textToVideo && ltx.imageToVideo).toBe(true)
  })

  test("maps each model's own spelling of a concept", () => {
    expect(wan.params.fps?.name).toBe("frames_per_second")
    expect(seedance.params.audio?.name).toBe("generate_audio")
    expect(kling.params.audio?.name).toBe("sound")
  })

  test("free numeric fps has no invented range", () => {
    expect(fps(wan)).toEqual({ values: [], min: undefined, max: undefined, default: 16 })
  })

  test("sorts resolutions from smallest to largest", () => {
    expect(resolutions(seedance)).toEqual(["480p", "720p", "1080p", "4k"])
  })
})

describe("request", () => {
  test("only sends fields LTX-2 Fast declares, with audio explicitly off", () => {
    const built = build(ltx, { prompt: "particles in a dark space" }, T2V)
    expect(Object.keys(built.body).sort()).toEqual(["duration", "generateAudio", "model", "prompt"])
    expect(built.body.duration).toBe("8")
    expect(built.body.generateAudio).toBe(false)
    expect(built.settings.duration).toBe(8)
  })

  test("never sends fps to a model without fps control", () => {
    const built = build(ltx, { prompt: "city", fps: 24 }, T2V)
    expect(Object.values(built.body)).not.toContain(24)
    expect(built.body.fps).toBeUndefined()
    expect(built.body.frames_per_second).toBeUndefined()
    expect(built.warnings.some((warning) => warning.includes("frame rate"))).toBe(true)
  })

  test("snaps an unsupported duration to the nearest real option", () => {
    const built = build(ltx, { prompt: "city", duration: 13 }, T2V)
    expect(built.body.duration).toBe("12")
    expect(built.warnings.length).toBeGreaterThan(0)
  })

  test("image-only models require a reference image", () => {
    expectKind(() => build(wan, { prompt: "animate" }, T2V), "unsupported_setting")
  })

  test("image-to-video with fps uses the model's real field names and types", () => {
    const built = build(wan, { prompt: "animate", referenceImage: IMAGE, fps: 20 }, T2V, "attachment")
    expect(built.body.imageDataUrl).toBe(IMAGE)
    expect(built.body.frames_per_second).toBe(20)
    expect(built.body.resolution).toBe("720p")
    expect(String(built.body.negative_prompt)).toContain("watermark")
    expect(built.settings.referenceImage).toBe("attachment")
  })

  test("quality presets choose only declared resolutions", () => {
    expect(build(seedance, { prompt: "x", quality: "draft" }, T2V).body.resolution).toBe("480p")
    expect(build(seedance, { prompt: "x", quality: "standard" }, T2V).body.resolution).toBe("720p")
    expect(build(seedance, { prompt: "x", quality: "high" }, T2V).body.resolution).toBe("4k")
  })

  test("aspect ratio and audio follow the model's own fields", () => {
    const built = build(seedance, { prompt: "x", aspectRatio: "9:16" }, T2V)
    expect(built.body.aspect_ratio).toBe("9:16")
    expect(built.body.generate_audio).toBe(false)
  })

  test("rejects non-https reference images", () => {
    expectKind(() => build(ltx, { prompt: "x", referenceImage: "http://example.com/a.png" }, T2V), "invalid_attachment")
  })
})

describe("photo (image-to-video)", () => {
  test("reads the photo size from PNG and JPEG data URLs", () => {
    expect(imageSize(PORTRAIT_PNG)).toEqual({ width: 720, height: 950 })
    expect(imageSize(LANDSCAPE_JPEG)).toEqual({ width: 1920, height: 1080 })
    expect(imageSize("https://example.com/a.png")).toBeUndefined()
    expect(imageSize(IMAGE)).toBeUndefined()
  })

  test("picks the closest aspect ratio the model offers", () => {
    expect(nearestAspect(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], { width: 720, height: 950 })).toBe("3:4")
    // 1:1 crops a 720x950 photo less than 9:16 does.
    expect(nearestAspect(["16:9", "9:16", "1:1"], { width: 720, height: 950 })).toBe("1:1")
    expect(nearestAspect(["16:9", "9:16", "1:1"], { width: 1080, height: 1920 })).toBe("9:16")
    expect(nearestAspect(["auto"], { width: 1, height: 1 })).toBeUndefined()
  })

  test("refuses to generate without a photo by default", () => {
    expectKind(() => build(ltx, { prompt: "particles" }, DEFAULTS), "missing_image")
  })

  test("the video follows the photo's proportions unless a format is requested", () => {
    const built = build(seedance, { prompt: "the cap opens", referenceImage: PORTRAIT_PNG }, DEFAULTS, "attachment")
    expect(built.body.aspect_ratio).toBe("3:4")
    expect(built.body.imageDataUrl).toBe(PORTRAIT_PNG)
    expect(built.settings.referenceImage).toBe("attachment")
    const forced = build(seedance, { prompt: "x", referenceImage: PORTRAIT_PNG, aspectRatio: "16:9" }, DEFAULTS)
    expect(forced.body.aspect_ratio).toBe("16:9")
    // https photos can't be measured, so the model decides instead of a wrong default.
    const remote = build(seedance, { prompt: "x", referenceImage: "https://example.com/p.jpg" }, DEFAULTS)
    expect(remote.body.aspect_ratio).toBeUndefined()
    expect(remote.body.imageUrl).toBe("https://example.com/p.jpg")
  })

  test("photo prompts preserve the subject and its label instead of banning logos", () => {
    const built = build(
      ltx,
      { prompt: "the cap slowly opens", purpose: "product", referenceImage: PORTRAIT_PNG },
      DEFAULTS,
    )
    expect(built.finalPrompt).toStartWith("Animate the reference photo into a premium product hero shot for a website:")
    expect(built.finalPrompt).toContain("the cap slowly opens")
    expect(built.finalPrompt).toContain("exact design, materials, colors and label artwork")
    // Identity is preserved without freezing the pose the requested action changes.
    expect(built.finalPrompt).not.toContain("same shape")
    expect(built.finalPrompt).not.toMatch(/logos|subtitles|captions/)
  })

  test("text-related words only reach the negative prompt field", () => {
    const withField = build(wan, { prompt: "the cap opens", referenceImage: PORTRAIT_PNG }, DEFAULTS)
    expect(withField.finalPrompt).not.toMatch(/subtitles|captions|typography/)
    expect(String(withField.body.negative_prompt)).toContain("subtitles")
    expect(String(withField.body.negative_prompt)).toContain("morphing")
  })
})

describe("photo models priced per mode or per output second", () => {
  test("Gemini Omni Flash 1.1 bills the image-to-video rate and picks its closest format", () => {
    const built = build(gemini, { prompt: "the cap opens", duration: 8, referenceImage: PORTRAIT_PNG }, DEFAULTS)
    expect(built.body).toMatchObject({ duration: "8", resolution: "720p", aspect_ratio: "9:16" })
    expect(built.estimatedCost).toBe(1.12)
    expect(estimate(gemini, { mode: "text_to_video", duration: 8, resolution: "720p", audio: false })).toBe(1.04)
  })

  test("MiniMax H3 skips fields that only apply to LoRA, edit or extend modes", () => {
    expect(h3.params.resolution).toBeUndefined()
    expect(h3.params.audio).toBeUndefined()
    const built = build(h3, { prompt: "the cap opens", duration: 8, referenceImage: PORTRAIT_PNG }, DEFAULTS)
    expect(Object.keys(built.body).sort()).toEqual(["duration", "imageDataUrl", "model", "prompt"])
    expect(built.estimatedCost).toBe(1.04)
  })
})

describe("agent options", () => {
  test("a placeholder-filled call keeps only what was really chosen", () => {
    // Real call from a strict function-calling backend: it asked for a 2s 480p draft.
    const input = {
      prompt: "the steel cap unscrews, lifts off and hovers above the bottle, then screws back on",
      preset: "hero-3d",
      purpose: "product",
      model: "bytedance-seedance-v1-pro-fast",
      duration: 0,
      aspectRatio: "16:9",
      resolution: "",
      fps: 0,
      quality: "draft",
      motion: "subtle",
      cameraMovement: "static",
      loopFriendly: false,
      scrollFriendly: false,
      generateAudio: false,
      negativePrompt: "",
      seed: 0,
      inferenceSteps: 0,
      numFrames: 0,
      cameraFixed: false,
      cfgScale: 0,
      proMode: false,
      includeText: false,
      referenceImage: "",
    }
    expect(clean(input)).toEqual({
      prompt: input.prompt,
      preset: "hero-3d",
      purpose: "product",
      model: "bytedance-seedance-v1-pro-fast",
    })
    const built = build(ltx, { ...clean(input), referenceImage: PORTRAIT_PNG }, DEFAULTS)
    expect(built.settings).toMatchObject({ duration: 10, quality: "standard", loopFriendly: true })
  })

  test("a normal call keeps explicit false and first enum values", () => {
    expect(clean({ prompt: "x", quality: "draft", loopFriendly: false, duration: 6, aspectRatio: "16:9" })).toEqual({
      prompt: "x",
      quality: "draft",
      loopFriendly: false,
      duration: 6,
      aspectRatio: "16:9",
    })
    expect(clean({ prompt: "x", duration: null, resolution: null, model: " minimax-h3 " })).toEqual({
      prompt: "x",
      model: "minimax-h3",
    })
  })
})

describe("presets", () => {
  const BOTTLE_CAP = "the steel cap unscrews, lifts off and hovers above the bottle, then screws back on"

  test("hero 3D turns the product 360 degrees, stages its reveal and loops back", () => {
    const built = build(ltx, { prompt: BOTTLE_CAP, preset: "hero-3d", referenceImage: PORTRAIT_PNG }, DEFAULTS)
    const prompt = built.finalPrompt
    expect(prompt).toStartWith("Premium 3D product hero video for a website, animated from the reference photo.")
    expect(prompt).toContain("full 360 degrees around its vertical axis")
    expect(prompt).toContain(`Reveal moment: ${BOTTLE_CAP}.`)
    expect(prompt).toContain("fully assembled in exactly the starting pose")
    expect(prompt).toContain("stays in the air close to the product")
    expect(prompt).toContain("exact design, materials, colors and label artwork")
    // Order matters to video models: the turn comes before the reveal, the loop last.
    expect(prompt.indexOf("360 degrees")).toBeLessThan(prompt.indexOf("Reveal moment"))
    expect(prompt.indexOf("Reveal moment")).toBeLessThan(prompt.indexOf("starting pose"))
    // The style replaces the generic boilerplate instead of piling onto it.
    expect(prompt).not.toContain("suitable for scroll-controlled playback")
    expect(prompt).not.toMatch(/\b(text|typography|logos|subtitles|watermark)\b/)
  })

  test("a preset brings its own settings, but explicit requests still win", () => {
    const styled = build(ltx, { prompt: BOTTLE_CAP, preset: "hero-3d", referenceImage: PORTRAIT_PNG }, DEFAULTS)
    expect(styled.settings).toMatchObject({
      preset: "hero-3d",
      purpose: "product",
      duration: 10,
      motion: "subtle",
      cameraMovement: "static",
      loopFriendly: true,
    })
    const custom = build(
      ltx,
      { prompt: BOTTLE_CAP, preset: "hero-3d", duration: 6, referenceImage: PORTRAIT_PNG },
      DEFAULTS,
    )
    expect(custom.settings.duration).toBe(6)
  })

  test("the saved default preset applies when the request doesn't name one", () => {
    const built = build(ltx, { prompt: "", referenceImage: PORTRAIT_PNG }, { ...DEFAULTS, preset: "turntable" })
    expect(built.settings.preset).toBe("turntable")
    expect(built.finalPrompt).toContain("constant, gentle speed")
    expect(built.finalPrompt).not.toContain("Reveal moment")
  })

  test("hero 3D without details still stages a generic reveal", () => {
    const built = build(ltx, { prompt: "", preset: "hero-3d", referenceImage: PORTRAIT_PNG }, DEFAULTS)
    expect(built.finalPrompt).toContain("one elegant reveal of its key part")
  })
})

describe("prompt", () => {
  test("keeps the user's words and adds web-video traits once", () => {
    const prompt = buildWebVideoPrompt("futuristic city at night", {
      purpose: "hero",
      motion: "subtle",
      cameraMovement: "slow-pan",
      loopFriendly: true,
      scrollFriendly: true,
      includeText: false,
    })
    expect(prompt).toContain("futuristic city at night")
    expect(prompt).toContain("clean, uncluttered frame")
    // Naming text in a prompt makes models draw it, even when negated.
    expect(prompt).not.toMatch(/\b(text|typography|logos|subtitles|watermark|overlaid)\b/)
    expect(prompt).toContain("no cuts")
    expect(prompt).toContain("ending composition visually connects with the beginning")
    expect(prompt.split("stable composition")).toHaveLength(2)
  })

  test("allows text when explicitly requested", () => {
    const prompt = buildWebVideoPrompt("neon sign", {
      purpose: "section",
      motion: "medium",
      cameraMovement: "custom",
      loopFriendly: false,
      scrollFriendly: false,
      includeText: true,
    })
    expect(prompt).not.toContain("uncluttered")
  })
})

describe("cost", () => {
  test("per_second pricing", () => {
    expect(estimate(ltx, { mode: "text_to_video", duration: 8, audio: false })).toBe(0.32)
  })

  test("per_second_by_resolution pricing", () => {
    expect(estimate(seedance, { mode: "text_to_video", duration: 5, resolution: "720p", audio: false })).toBe(1.8)
  })

  test("per_duration pricing with audio multiplier", () => {
    expect(estimate(kling, { mode: "text_to_video", duration: 5, audio: false })).toBe(0.35)
    expect(estimate(kling, { mode: "text_to_video", duration: 5, audio: true })).toBe(0.7)
  })

  test("with/without audio flat pricing", () => {
    expect(estimate(veo, { mode: "text_to_video", audio: true })).toBe(4.8)
    expect(estimate(veo, { mode: "text_to_video", audio: false })).toBe(3.2)
  })

  test("per_resolution pricing with frame multiplier", () => {
    expect(estimate(wan, { mode: "text_to_video", resolution: "720p", audio: false, numFrames: 81 })).toBe(0.4)
    expect(estimate(wan, { mode: "text_to_video", resolution: "720p", audio: false, numFrames: 100 })).toBe(0.5)
  })

  test("unknown pricing fields make the estimate unavailable instead of wrong", () => {
    expect(estimate(minimax, { mode: "text_to_video", duration: 5, audio: false })).toBeUndefined()
  })
})

describe("status", () => {
  test("reads the documented create response", () => {
    expect(parseCreated({ runId: "vid_1", status: "pending", model: "m", cost: 0.35 })).toEqual({
      runId: "vid_1",
      status: "pending",
      model: "m",
      cost: 0.35,
    })
    expectKind(() => parseCreated({ status: "pending" }), "generation_failed")
  })

  test("reads the documented completed response", () => {
    const status = parseStatus({
      data: { status: "COMPLETED", output: { video: { url: "https://cdn.example/v.mp4" } }, cost: 0.35 },
    })
    expect(status).toEqual({ phase: "completed", url: "https://cdn.example/v.mp4", cost: 0.35 })
  })

  test("maps intermediate states without inventing progress", () => {
    expect(parseStatus({ data: { status: "IN_PROGRESS" } }).phase).toBe("processing")
    expect(parseStatus({ data: { status: "queued" } }).phase).toBe("queued")
    expect(parseStatus({ data: { status: "delivering" } }).phase).toBe("finishing")
  })

  test("content policy failures are classified", () => {
    const status = parseStatus({
      data: { status: "FAILED", error: "Content policy violation", isNSFWError: true, userFriendlyError: "Flagged." },
    })
    expect(status.error).toEqual({ kind: "content_policy", message: "Flagged." })
  })

  test("completed without a url is a failure, not a broken player", () => {
    expect(parseStatus({ data: { status: "COMPLETED" } }).phase).toBe("failed")
  })

  test("classifies HTTP errors", () => {
    expect(classifyHttpError(401, {}).kind).toBe("invalid_api_key")
    expect(classifyHttpError(402, {}).kind).toBe("insufficient_balance")
    expect(classifyHttpError(429, {}).kind).toBe("rate_limited")
    expect(classifyHttpError(400, { error: { message: "Safety filter triggered" } }).kind).toBe("content_policy")
    expect(classifyHttpError(400, { error: "Model not found" }).kind).toBe("invalid_model")
    expect(classifyHttpError(503, {}).kind).toBe("provider_unavailable")
  })

  test("redacts secrets", () => {
    expect(redact("key sk-nano-abcdef123456 leaked", ["sk-nano-abcdef123456"])).toBe("key [redacted] leaked")
  })
})
