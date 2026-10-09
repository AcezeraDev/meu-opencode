import { describe, expect, test } from "bun:test"
import {
  frameParts,
  socialPrepTask,
  socialTask,
  startSocialClock,
  type SocialPost,
  type SocialQueue,
} from "./social-clock"

const NOW = 1_000_000_000
const MINUTE = 60_000

function post(input: Partial<SocialPost> & { id: string }): SocialPost {
  return {
    video: `C:/data/social/videos/${input.id}.mp4`,
    name: `${input.id}.mp4`,
    network: "instagram",
    at: NOW - 1,
    notes: "",
    status: "scheduled",
    created: 0,
    updated: 0,
    ...input,
  }
}

function harness(posts: SocialPost[], running: string[] = [], lose = false) {
  const queue: SocialQueue = { directory: "C:/data/social", posts }
  const log: string[] = []
  const found = (id: string) => queue.posts.find((item) => item.id === id)!
  const clock = startSocialClock({
    list: async () => queue,
    running: async () => new Set(running),
    create: async (_dir, item, agent) => {
      log.push(`create ${item.id} ${agent}`)
      return `ses_${item.id}`
    },
    claim: async (id, sessionID) => {
      log.push(`claim ${id}`)
      if (lose) return undefined
      return Object.assign(found(id), { status: "producing", sessionID, started: NOW })
    },
    claimPrep: async (id, sessionID) => {
      log.push(`prepare ${id}`)
      if (lose) return undefined
      return Object.assign(found(id), { prep: { sessionID, started: NOW, status: "running" } })
    },
    discard: async (_dir, sessionID) => {
      log.push(`discard ${sessionID}`)
    },
    send: async (_dir, sessionID) => {
      log.push(`send ${sessionID}`)
    },
    sendPrep: async (_dir, sessionID) => {
      log.push(`sendPrep ${sessionID}`)
    },
    fail: async (id) => {
      log.push(`fail ${id}`)
      Object.assign(found(id), { status: "failed" })
    },
    unprepared: async (id) => {
      log.push(`unprepared ${id}`)
      const prep = found(id).prep
      Object.assign(found(id), { prep: prep && { ...prep, status: "failed" } })
    },
    text: { stopped: "stopped", sendFailed: "send failed" },
    now: () => NOW,
    every: 3_600_000,
  })
  return { clock, log, queue }
}

async function run(posts: SocialPost[], running: string[] = [], lose = false) {
  const result = harness(posts, running, lose)
  await result.clock.first
  result.clock.stop()
  return result
}

describe("social clock", () => {
  test("starts the oldest due post, and only one at a time", async () => {
    const first = await run([
      post({ id: "later", at: NOW + 60 * MINUTE }),
      post({ id: "b", at: NOW - 10 }),
      post({ id: "a", at: NOW - 5_000 }),
    ])
    expect(first.log).toEqual(["create a social", "claim a", "send ses_a"])

    // Post "a" is still being made, so "b" waits.
    const next = await run(first.queue.posts, ["ses_a"])
    expect(next.log).toEqual([])
  })

  test("a session that stopped without reporting fails its post, and the next one goes", async () => {
    const result = await run([
      post({ id: "a", status: "producing", sessionID: "ses_a", started: NOW - 10 * MINUTE }),
      post({ id: "b" }),
    ])
    expect(result.log).toEqual(["fail a", "create b social", "claim b", "send ses_b"])
  })

  test("gives a just-started session time before calling it stopped", async () => {
    const result = await run([post({ id: "a", status: "producing", sessionID: "ses_a", started: NOW - 5_000 })])
    expect(result.log).toEqual([])
  })

  test("drops its session when another window claimed the post first", async () => {
    const result = await run([post({ id: "a" })], [], true)
    expect(result.log).toEqual(["create a social", "claim a", "discard ses_a"])
  })

  test("prepares the caption ten minutes before, not earlier, unless asked", async () => {
    const soon = await run([post({ id: "a", at: NOW + 8 * MINUTE })])
    expect(soon.log).toEqual(["create a social-prep", "prepare a", "sendPrep ses_a"])

    const far = await run([post({ id: "a", at: NOW + 30 * MINUTE })])
    expect(far.log).toEqual([])

    const asked = await run([post({ id: "a", at: NOW + 30 * MINUTE, prepNow: true })])
    expect(asked.log).toEqual(["create a social-prep", "prepare a", "sendPrep ses_a"])
  })

  test("does not prepare a caption the person wrote, or one already prepared", async () => {
    const result = await run([
      post({ id: "own", at: NOW + 5 * MINUTE, caption: "Minha" }),
      post({ id: "done", at: NOW + 5 * MINUTE, prep: { sessionID: "x", started: 0, status: "done" }, draft: "Pronta" }),
    ])
    expect(result.log).toEqual([])
  })

  test("a due post goes before preparing another", async () => {
    const result = await run([post({ id: "soon", at: NOW + 5 * MINUTE }), post({ id: "due", at: NOW - 1 })])
    expect(result.log).toEqual(["create due social", "claim due", "send ses_due"])
  })

  test("a running prep holds the browser; one that stopped leaves the caption for posting time", async () => {
    const prep = { sessionID: "ses_a", started: NOW - 5 * MINUTE, status: "running" as const }
    const busy = await run([post({ id: "a", at: NOW + 5 * MINUTE, prep }), post({ id: "b" })], ["ses_a"])
    expect(busy.log).toEqual([])

    const stopped = await run([post({ id: "a", at: NOW + 5 * MINUTE, prep }), post({ id: "b" })])
    expect(stopped.log).toEqual(["unprepared a", "create b social", "claim b", "send ses_b"])
  })

  test("the task names the post, the file and who writes the caption", () => {
    expect(socialTask(post({ id: "a", notes: "promo" }))).toContain("Legenda: escreva você.")
    const own = socialTask(post({ id: "a", network: "tiktok", caption: "Minha legenda" }))
    expect(own).toContain("Rede: TikTok")
    expect(own).toContain("Minha legenda")
    expect(own).toContain("id: a")
    // A claimed post carries its caption as a write_text reference, typed exactly.
    expect(socialTask(post({ id: "a", draft: "Da IA", captionRef: "@texto:abc" }))).toContain("@texto:abc")
  })

  test("the prep task has the stills, shape and profile, but never the video's path", () => {
    const item = post({
      id: "a",
      frames: ["C:\\data\\social\\frames\\a-1.jpg", "C:\\data\\social\\frames\\a-2.jpg"],
      duration: 31.6,
      width: 1080,
      height: 1920,
    })
    const fresh = socialPrepTask(item, { instagram: { summary: "Perfil de doces", updated: NOW - MINUTE } }, NOW)
    expect(fresh).toContain("não poste nada")
    expect(fresh).toContain("32 s, vertical (1080×1920)")
    expect(fresh).toContain("Quadros do vídeo em anexo: 2")
    expect(fresh).toContain("Perfil de doces")
    expect(fresh).not.toContain(item.video)

    const stale = socialPrepTask(item, { instagram: { summary: "Velho", updated: NOW - 10 * 24 * 60 * MINUTE } }, NOW)
    expect(stale).toContain("leia o perfil")
    expect(frameParts(item)[0]).toMatchObject({
      type: "file",
      mime: "image/jpeg",
      url: "file:///C:/data/social/frames/a-1.jpg",
    })
  })
})
