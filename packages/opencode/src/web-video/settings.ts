export * as WebVideoSettings from "./settings"

import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import {
  CAMERA_MOVEMENTS,
  DEFAULTS,
  MOTIONS,
  PRESETS,
  PURPOSES,
  QUALITIES,
  type Defaults,
} from "@opencode-ai/core/web-video/types"

const file = () => path.join(Global.Path.data, "web-video.json")

/** `NANOGPT_DEFAULT_VIDEO_MODEL` overrides the built-in default model. */
export function defaultModel() {
  return process.env.NANOGPT_DEFAULT_VIDEO_MODEL?.trim() || DEFAULTS.model
}

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function flag(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

/** Accepts untrusted input (a file or an HTTP body) and returns valid defaults. */
export function sanitize(input: unknown): Defaults {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  return {
    model: text(value.model) ?? defaultModel(),
    preset: pick(PRESETS, value.preset, DEFAULTS.preset),
    purpose: pick(PURPOSES, value.purpose, DEFAULTS.purpose),
    duration: positive(value.duration) ?? DEFAULTS.duration,
    aspectRatio: text(value.aspectRatio) ?? DEFAULTS.aspectRatio,
    quality: pick(QUALITIES, value.quality, DEFAULTS.quality),
    resolution: text(value.resolution),
    fps: positive(value.fps),
    motion: pick(MOTIONS, value.motion, DEFAULTS.motion),
    cameraMovement: pick(CAMERA_MOVEMENTS, value.cameraMovement, DEFAULTS.cameraMovement),
    loopFriendly: flag(value.loopFriendly, DEFAULTS.loopFriendly),
    scrollFriendly: flag(value.scrollFriendly, DEFAULTS.scrollFriendly),
    generateAudio: flag(value.generateAudio, DEFAULTS.generateAudio),
    requireImage: flag(value.requireImage, DEFAULTS.requireImage),
  }
}

export async function load(): Promise<Defaults> {
  const stored: unknown = await Filesystem.readJson(file()).catch(() => ({}))
  return sanitize(stored)
}

/**
 * Replaces the saved defaults. Callers send the complete settings object, so an
 * omitted optional field (e.g. `fps` after switching to a model without FPS)
 * really clears it instead of resurrecting the previously stored value.
 */
export async function save(input: unknown): Promise<Defaults> {
  const next = sanitize(input)
  await Filesystem.write(file(), JSON.stringify(next, null, 2))
  return next
}
