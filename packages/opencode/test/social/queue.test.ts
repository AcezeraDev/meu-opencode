import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SocialQueue } from "../../src/social/queue"

async function video(name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "social-"))
  const file = path.join(dir, name)
  await fs.writeFile(file, "fake video bytes")
  return file
}

describe("posting queue", () => {
  test("copies the video, hands a due post to one session only and drops the copy once posted", async () => {
    const source = await video("promo.mp4")
    const post = await SocialQueue.add({ source, network: "instagram", at: Date.now() - 60_000, notes: " promoção " })
    expect(post).toMatchObject({ name: "promo.mp4", network: "instagram", status: "scheduled", notes: "promoção" })
    expect(post.video.startsWith(SocialQueue.directory())).toBe(true)
    // The original can go away after scheduling.
    await fs.rm(source)
    expect(await fs.readFile(post.video, "utf8")).toBe("fake video bytes")

    expect(SocialQueue.due(await SocialQueue.list()).map((item) => item.id)).toContain(post.id)
    const [first, second] = await Promise.all([
      SocialQueue.claim(post.id, "ses_a"),
      SocialQueue.claim(post.id, "ses_b"),
    ])
    expect([first?.sessionID, second?.sessionID].filter(Boolean)).toHaveLength(1)
    expect(SocialQueue.due(await SocialQueue.list()).map((item) => item.id)).not.toContain(post.id)

    const done = await SocialQueue.report(post.id, { status: "posted", caption: "Oferta!", url: "https://x/p/1" })
    expect(done).toMatchObject({ status: "posted", posted: "Oferta!", url: "https://x/p/1" })
    expect(await fs.stat(post.video).catch(() => undefined)).toBeUndefined()
  })

  test("a future post is not due, and a failed one goes back to scheduled when retried", async () => {
    const post = await SocialQueue.add({ source: await video("b.mp4"), network: "tiktok", at: Date.now() + 3_600_000 })
    expect(await SocialQueue.claim(post.id, "ses_c")).toBeUndefined()

    const moved = await SocialQueue.edit(post.id, { at: Date.now() - 1 })
    expect((await SocialQueue.claim(post.id, "ses_c"))?.status).toBe("producing")
    expect(moved?.status).toBe("scheduled")

    const failed = await SocialQueue.report(post.id, { status: "failed", reason: "Não está logado no TikTok" })
    expect(failed).toMatchObject({ status: "failed", error: "Não está logado no TikTok" })
    const retried = await SocialQueue.edit(post.id, { status: "scheduled" })
    expect(retried).toMatchObject({ status: "scheduled", error: undefined, sessionID: undefined })

    const removed = await SocialQueue.remove(post.id)
    expect(removed?.id).toBe(post.id)
    expect((await SocialQueue.list()).some((item) => item.id === post.id)).toBe(false)
    expect(await fs.stat(post.video).catch(() => undefined)).toBeUndefined()
  })

  test("keeps the stills, prepares the caption once, near its time, and keeps what it learned of the profile", async () => {
    const jpeg = `data:image/jpeg;base64,${Buffer.from("fake jpeg").toString("base64")}`
    const post = await SocialQueue.add({
      source: await video("doce.mp4"),
      network: "instagram",
      at: Date.now() + 60 * 60_000,
      frames: [jpeg, jpeg, "data:text/plain;base64,eA=="],
      duration: 12,
      width: 1080,
      height: 1920,
    })
    // Only JPEGs are kept.
    expect(post.frames).toHaveLength(2)
    expect(await fs.readFile(post.frames![0], "utf8")).toBe("fake jpeg")

    // An hour ahead it is too early, unless the person asks.
    expect(await SocialQueue.claimPrep(post.id, "ses_p")).toBeUndefined()
    await SocialQueue.edit(post.id, { prepare: true })
    const [first, second] = await Promise.all([
      SocialQueue.claimPrep(post.id, "ses_p"),
      SocialQueue.claimPrep(post.id, "ses_q"),
    ])
    expect([first?.prep?.sessionID, second?.prep?.sessionID].filter(Boolean)).toHaveLength(1)

    const prepared = await SocialQueue.report(post.id, {
      status: "prepared",
      caption: "Brigadeiro de colher 🍫 #doces",
      analysis: "Mãos montando um pote de brigadeiro.",
      profile: "Confeitaria caseira, tom carinhoso.",
    })
    expect(prepared).toMatchObject({ draft: "Brigadeiro de colher 🍫 #doces", status: "scheduled" })
    expect(prepared?.prep?.status).toBe("done")
    await Bun.sleep(50)
    expect((await SocialQueue.profiles()).instagram?.summary).toBe("Confeitaria caseira, tom carinhoso.")
    // Done once: no second prep by itself, nor ten minutes before.
    expect(SocialQueue.needsPrep(prepared!, prepared!.at - 5 * 60_000)).toBe(false)

    // The person's edit wins over the draft; asking again clears it for a new one.
    const edited = await SocialQueue.edit(post.id, { caption: "Minha versão" })
    expect(edited).toMatchObject({ caption: "Minha versão", draft: "Brigadeiro de colher 🍫 #doces" })
    const again = await SocialQueue.edit(post.id, { prepare: true })
    expect(again).toMatchObject({ caption: undefined, prep: undefined, prepNow: true })

    await SocialQueue.remove(post.id)
    expect(await fs.stat(post.frames![0]).catch(() => undefined)).toBeUndefined()
  })

  test("ten minutes before its time a post needs its caption; a due one does not", () => {
    const now = Date.now()
    const base = { id: "x", video: "", name: "", network: "tiktok", notes: "", status: "scheduled", created: 0, updated: 0 } as const
    expect(SocialQueue.needsPrep({ ...base, at: now + 9 * 60_000 }, now)).toBe(true)
    expect(SocialQueue.needsPrep({ ...base, at: now + 11 * 60_000 }, now)).toBe(false)
    expect(SocialQueue.needsPrep({ ...base, at: now - 1 }, now)).toBe(false)
    expect(SocialQueue.needsPrep({ ...base, at: now + 9 * 60_000, caption: "Minha" }, now)).toBe(false)
  })

  test("refuses a video that does not exist", async () => {
    await expect(
      SocialQueue.add({ source: path.join(os.tmpdir(), "nao-existe.mp4"), network: "instagram", at: Date.now() }),
    ).rejects.toThrow("Video not found")
  })
})
