import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"

/**
 * The person's posting queue: videos they dropped in, each with the network it
 * goes to and the time it should go out. The app's clock claims a post when
 * its time comes and starts a session with the social agent, which posts it
 * through the person's own browser and reports back with `social_report`.
 *
 * A few minutes before that, the clock has the social-prep agent look at the
 * video's frames and the person's profile and write the caption, so the
 * person can read it (and change it) before it goes out.
 *
 * One JSON file under `Global.Path.data/social`, written by Node's fs because
 * the desktop server runs on Node. Each video is copied next to it, so moving
 * or deleting the original after scheduling does not lose the post.
 */

export const NETWORKS = ["instagram", "tiktok"] as const
export type Network = (typeof NETWORKS)[number]

export const STATUSES = ["scheduled", "producing", "posted", "failed"] as const
export type Status = (typeof STATUSES)[number]

/** How long before its time a post's caption is prepared. */
export const PREPARE_MS = 10 * 60 * 1000
/** A profile read this recently is reused instead of opening the site again. */
export const PROFILE_FRESH_MS = 3 * 24 * 60 * 60 * 1000
const MAX_FRAMES = 8

export type Post = {
  id: string
  /** The copy of the video the agent uploads. */
  video: string
  /** The file's name as the person dropped it, for showing and for a hint of what it is. */
  name: string
  network: Network
  /** When it should go out, in milliseconds. */
  at: number
  /** What the person wants said or stressed in the caption. */
  notes: string
  /** A caption the person wrote themselves (or edited); the agent uses it as is. */
  caption?: string
  model?: { providerID: string; modelID: string }
  status: Status
  sessionID?: string
  /** When the clock claimed it. */
  started?: number
  /** Stills taken from the video when it was scheduled, so a model can see what it shows. */
  frames?: string[]
  /** Seconds. */
  duration?: number
  width?: number
  height?: number
  /** The caption the social-prep agent wrote ahead of time. */
  draft?: string
  /** What the social-prep agent saw in the video, in a sentence or two. */
  analysis?: string
  prep?: { sessionID: string; started: number; status: "running" | "done" | "failed"; error?: string }
  /** The person asked for the caption now instead of waiting for its time. */
  prepNow?: boolean
  /** The caption that went out. */
  posted?: string
  url?: string
  error?: string
  created: number
  updated: number
}

export type Input = {
  source: string
  network: Network
  at: number
  notes?: string
  caption?: string
  model?: { providerID: string; modelID: string }
  /** JPEG data URLs of stills from the video. */
  frames?: readonly string[]
  duration?: number
  width?: number
  height?: number
}

export type Report =
  | { status: "posted" | "failed"; caption?: string; url?: string; reason?: string }
  /** The social-prep agent wrote the caption; `profile` is what it learned of the account. */
  | { status: "prepared"; caption?: string; analysis?: string; profile?: string }
  /** The prep session stopped without a caption; the posting agent writes one at the time. */
  | { status: "unprepared"; reason?: string }

export type Profiles = Partial<Record<Network, { summary: string; updated: number }>>

/** The folder the social sessions run in, so their videos are inside it. */
export const directory = () => path.join(Global.Path.data, "social")
const file = () => path.join(directory(), "queue.json")
const videos = () => path.join(directory(), "videos")
const framesDir = () => path.join(directory(), "frames")
const profilesFile = () => path.join(directory(), "profiles.json")
let writing: Promise<unknown> = Promise.resolve()

export async function list() {
  const posts = await read()
  return posts.toSorted((a, b) => a.at - b.at)
}

export async function get(id: string) {
  return (await read()).find((post) => post.id === id)
}

/** Copies the video and its stills in and queues it; one post per network. */
export function add(input: Input) {
  return change(async (posts) => {
    const source = path.resolve(input.source)
    const stat = await fs.stat(source).catch(() => undefined)
    if (!stat?.isFile()) throw new Error(`Video not found: ${source}`)
    const id = makeID()
    const video = path.join(videos(), `${id}-${path.basename(source)}`)
    await fs.mkdir(videos(), { recursive: true })
    await fs.copyFile(source, video)
    const frames = await saveFrames(id, input.frames ?? [])
    const now = Date.now()
    const post: Post = {
      id,
      video,
      name: path.basename(source),
      network: input.network,
      at: input.at,
      notes: input.notes?.trim() ?? "",
      caption: input.caption?.trim() || undefined,
      model: input.model,
      status: "scheduled",
      frames: frames.length ? frames : undefined,
      duration: input.duration,
      width: input.width,
      height: input.height,
      created: now,
      updated: now,
    }
    return { posts: [...posts, post], result: post }
  })
}

/**
 * Changes what the person can change; a failed post edited back to scheduled
 * is retried at its time, and `prepare` asks for a (new) caption right away.
 */
export function edit(
  id: string,
  input: {
    at?: number
    notes?: string
    caption?: string
    network?: Network
    status?: "scheduled"
    prepare?: boolean
  },
) {
  return update(id, (post) => {
    if (post.status === "producing") return post
    return {
      ...post,
      at: input.at ?? post.at,
      notes: input.notes?.trim() ?? post.notes,
      caption: input.caption === undefined ? post.caption : input.caption.trim() || undefined,
      network: input.network ?? post.network,
      ...(input.status === "scheduled" ? { status: "scheduled", error: undefined, sessionID: undefined } : {}),
      // A running prep is left to finish; asking again while it runs changes nothing.
      ...(input.prepare && post.prep?.status !== "running" ? { prep: undefined, prepNow: true, caption: undefined } : {}),
    }
  })
}

export function remove(id: string) {
  return change(async (posts) => {
    const post = posts.find((item) => item.id === id)
    if (post) await dropFiles(post, true)
    return { posts: posts.filter((item) => item.id !== id), result: post }
  })
}

/**
 * Marks a post as being made, if it is due and nobody took it yet, so two
 * windows or two ticks never post the same video twice. Posts whose time
 * passed while the app was closed are due too: they go out when it opens.
 */
export function claim(id: string, sessionID: string, now = Date.now()) {
  return change(async (posts) => {
    const post = posts.find((item) => item.id === id)
    if (!post || post.status !== "scheduled" || post.at > now) return { posts, result: undefined }
    const claimed: Post = { ...post, status: "producing", sessionID, started: now, updated: now }
    return { posts: posts.map((item) => (item.id === id ? claimed : item)), result: claimed }
  })
}

/** Marks a post's caption as being prepared by the session, once, when it is time for that. */
export function claimPrep(id: string, sessionID: string, now = Date.now()) {
  return change(async (posts) => {
    const post = posts.find((item) => item.id === id)
    if (!post || !needsPrep(post, now)) return { posts, result: undefined }
    const claimed: Post = {
      ...post,
      prep: { sessionID, started: now, status: "running" },
      prepNow: undefined,
      updated: now,
    }
    return { posts: posts.map((item) => (item.id === id ? claimed : item)), result: claimed }
  })
}

/** What an agent said happened; a posted video's copy is no longer needed. */
export function report(id: string, input: Report) {
  if (input.status === "prepared" && input.profile?.trim()) void saveProfile(id, input.profile.trim())
  return update(id, async (post) => {
    if (input.status === "prepared") {
      return {
        ...post,
        draft: input.caption?.trim() || post.draft,
        analysis: input.analysis?.trim() || post.analysis,
        prep: post.prep && { ...post.prep, status: "done" },
      }
    }
    if (input.status === "unprepared") {
      return { ...post, prep: post.prep && { ...post.prep, status: "failed", error: input.reason?.trim() } }
    }
    if (input.status === "posted") await dropFiles(post, false)
    return {
      ...post,
      status: input.status,
      posted: input.caption?.trim() || post.posted,
      url: input.url?.trim() || post.url,
      error: input.status === "failed" ? input.reason?.trim() || "Failed without saying why" : undefined,
    }
  })
}

/** The posts that are due now, oldest first. */
export function due(posts: Post[], now = Date.now()) {
  return posts.filter((post) => post.status === "scheduled" && post.at <= now).toSorted((a, b) => a.at - b.at)
}

/**
 * Whether a post's caption should be prepared now: still ahead, no caption of
 * the person's own, no prep yet, and within ten minutes of its time (or asked
 * for). A due post skips this; the posting agent writes the caption itself.
 */
export function needsPrep(post: Post, now = Date.now()) {
  if (post.status !== "scheduled" || post.caption || post.prep || post.at <= now) return false
  return post.prepNow === true || post.at - PREPARE_MS <= now
}

export async function profiles(): Promise<Profiles> {
  const text = await fs.readFile(profilesFile(), "utf8").catch(() => "")
  if (!text) return {}
  const parsed: unknown = JSON.parse(text)
  return parsed && typeof parsed === "object" ? (parsed as Profiles) : {}
}

async function saveProfile(id: string, summary: string) {
  const post = await get(id)
  if (!post) return
  const next = { ...(await profiles()), [post.network]: { summary, updated: Date.now() } }
  await fs.mkdir(directory(), { recursive: true })
  await fs.writeFile(profilesFile(), JSON.stringify(next, null, 2))
}

async function saveFrames(id: string, frames: readonly string[]) {
  const images = frames
    .slice(0, MAX_FRAMES)
    .flatMap((frame) => {
      const match = /^data:image\/jpeg;base64,(.+)$/.exec(frame)
      return match ? [Buffer.from(match[1], "base64")] : []
    })
  if (images.length === 0) return []
  await fs.mkdir(framesDir(), { recursive: true })
  return Promise.all(
    images.map(async (image, index) => {
      const target = path.join(framesDir(), `${id}-${index + 1}.jpg`)
      await fs.writeFile(target, image)
      return target
    }),
  )
}

/** A posted video's copy goes; its stills go with the post itself, since the list still shows it. */
async function dropFiles(post: Post, frames: boolean) {
  await fs.rm(post.video, { force: true })
  if (frames) await Promise.all((post.frames ?? []).map((frame) => fs.rm(frame, { force: true })))
}

function update(id: string, apply: (post: Post) => Post | Promise<Post>) {
  return change(async (posts) => {
    const post = posts.find((item) => item.id === id)
    if (!post) return { posts, result: undefined }
    const next = { ...(await apply(post)), updated: Date.now() }
    return { posts: posts.map((item) => (item.id === id ? next : item)), result: next }
  })
}

/** Reads, changes and writes the queue one change at a time. */
function change<T>(apply: (posts: Post[]) => Promise<{ posts: Post[]; result: T }>) {
  const next = writing.then(async () => {
    const changed = await apply(await read())
    await fs.mkdir(directory(), { recursive: true })
    const temp = `${file()}.${process.pid}.tmp`
    await fs.writeFile(temp, JSON.stringify(changed.posts, null, 2))
    await fs.rename(temp, file())
    return changed.result
  })
  writing = next.catch(() => undefined)
  return next
}

async function read(): Promise<Post[]> {
  const text = await fs.readFile(file(), "utf8").catch(() => "")
  if (!text) return []
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : []
}

function makeID() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export * as SocialQueue from "./queue"
