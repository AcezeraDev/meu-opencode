export type SocialNetwork = "instagram" | "tiktok"
export type SocialPost = {
  id: string
  video: string
  name: string
  network: SocialNetwork
  at: number
  notes: string
  caption?: string
  model?: { providerID: string; modelID: string }
  status: "scheduled" | "producing" | "posted" | "failed"
  sessionID?: string
  started?: number
  frames?: string[]
  duration?: number
  width?: number
  height?: number
  draft?: string
  analysis?: string
  prep?: { sessionID: string; started: number; status: "running" | "done" | "failed"; error?: string }
  prepNow?: boolean
  /** On a claim: the caption to post as a write_text reference. */
  captionRef?: string
  posted?: string
  url?: string
  error?: string
  created: number
  updated: number
}
export type SocialProfiles = Partial<Record<SocialNetwork, { summary: string; updated: number }>>
export type SocialQueue = { directory: string; posts: SocialPost[]; profiles?: SocialProfiles }

export const NETWORK_NAME: Record<SocialNetwork, string> = { instagram: "Instagram", tiktok: "TikTok" }

/** How often the clock looks at the queue. */
export const TICK_MS = 30_000
/** How long before its time a post's caption is prepared, as the server's queue has it. */
export const PREPARE_MS = 10 * 60 * 1000
/** A profile read this recently is reused instead of opening the site again. */
const PROFILE_FRESH_MS = 3 * 24 * 60 * 60 * 1000
/** A session gets this long to start running before an idle one counts as stopped. */
const GRACE_MS = 90_000

/**
 * The posting queue's clock. While the app is open it looks at the queue.
 * Ten minutes before a post's time it starts a session with the social-prep
 * agent to write the caption, so the person can read it first; when the time
 * comes (or passed while the app was closed) it starts a session with the
 * social agent to post it. One session at a time, since they all share the
 * person's browser, and posting goes before preparing. A posting session that
 * stopped without the agent reporting marks its post failed, so it can be
 * retried; a prep that stopped leaves the caption to the posting agent.
 */
export function startSocialClock(input: {
  list: () => Promise<SocialQueue | undefined>
  /** Sessions of the queue's folder that are running now. */
  running: (directory: string) => Promise<Set<string> | undefined>
  create: (directory: string, post: SocialPost, agent: "social" | "social-prep") => Promise<string | undefined>
  claim: (id: string, sessionID: string) => Promise<SocialPost | undefined>
  claimPrep: (id: string, sessionID: string) => Promise<SocialPost | undefined>
  /** Throws the session away when another window claimed the post first. */
  discard: (directory: string, sessionID: string) => Promise<void>
  send: (directory: string, sessionID: string, post: SocialPost, profiles: SocialProfiles) => Promise<void>
  sendPrep: (directory: string, sessionID: string, post: SocialPost, profiles: SocialProfiles) => Promise<void>
  fail: (id: string, reason: string) => Promise<void>
  unprepared: (id: string, reason: string) => Promise<void>
  text: { stopped: string; sendFailed: string }
  now?: () => number
  every?: number
}) {
  const now = input.now ?? Date.now
  const state = { ticking: false }

  const tick = async () => {
    if (state.ticking) return
    state.ticking = true
    await check().finally(() => {
      state.ticking = false
    })
  }

  const check = async () => {
    const queue = await input.list()
    if (!queue) return
    const making = queue.posts.filter((post) => post.status === "producing")
    const preparing = queue.posts.filter((post) => post.prep?.status === "running")
    if (making.length > 0 || preparing.length > 0) {
      const running = await input.running(queue.directory)
      if (!running) return
      const stopped = (sessionID: string | undefined, started: number | undefined) =>
        !!sessionID && !running.has(sessionID) && now() - (started ?? 0) > GRACE_MS
      const stoppedPosts = making.filter((post) => stopped(post.sessionID, post.started))
      const stoppedPreps = preparing.filter((post) => stopped(post.prep?.sessionID, post.prep?.started))
      await Promise.all([
        ...stoppedPosts.map((post) => input.fail(post.id, input.text.stopped)),
        ...stoppedPreps.map((post) => input.unprepared(post.id, input.text.stopped)),
      ])
      if (stoppedPosts.length < making.length || stoppedPreps.length < preparing.length) return
    }
    const profiles = queue.profiles ?? {}
    const post = queue.posts
      .filter((item) => item.status === "scheduled" && item.at <= now())
      .toSorted((a, b) => a.at - b.at)[0]
    if (post) {
      const sessionID = await input.create(queue.directory, post, "social")
      if (!sessionID) return
      const claimed = await input.claim(post.id, sessionID)
      if (!claimed) return input.discard(queue.directory, sessionID)
      await input
        .send(queue.directory, sessionID, claimed, profiles)
        .catch(() => input.fail(post.id, input.text.sendFailed))
      return
    }
    const prep = queue.posts.filter((item) => needsPrep(item, now())).toSorted((a, b) => a.at - b.at)[0]
    if (!prep) return
    const sessionID = await input.create(queue.directory, prep, "social-prep")
    if (!sessionID) return
    const claimed = await input.claimPrep(prep.id, sessionID)
    if (!claimed) return input.discard(queue.directory, sessionID)
    await input
      .sendPrep(queue.directory, sessionID, claimed, profiles)
      .catch(() => input.unprepared(prep.id, input.text.sendFailed))
  }

  // Right away too: posts whose time passed while the app was closed go out on opening.
  const first = tick()
  const timer = setInterval(() => void tick(), input.every ?? TICK_MS)
  return { first, tick, stop: () => clearInterval(timer) }
}

/** Mirrors the server's `SocialQueue.needsPrep`: still ahead, no caption of the person's, no prep yet, and close or asked for. */
export function needsPrep(post: SocialPost, now: number) {
  if (post.status !== "scheduled" || post.caption || post.prep || post.at <= now) return false
  return post.prepNow === true || post.at - PREPARE_MS <= now
}

/** What the social agent is told to do for one post. */
export function socialTask(post: SocialPost, profiles: SocialProfiles = {}, now = Date.now()) {
  const caption = post.captionRef ?? post.caption ?? post.draft
  return [
    `Post agendado — id: ${post.id}`,
    `Rede: ${NETWORK_NAME[post.network]}`,
    `Vídeo: ${post.video}`,
    `Nome do arquivo: ${post.name}`,
    `Observações: ${post.notes || "(nenhuma)"}`,
    ...(caption
      ? [`Legenda pronta (digite exatamente esta, sem reescrever):\n${caption}`]
      : ["Legenda: escreva você.", ...videoLines(post), ...profileLines(post, profiles, now, false)]),
  ].join("\n")
}

/** What the social-prep agent is told: everything about the video but where it is, so it cannot upload it. */
export function socialPrepTask(post: SocialPost, profiles: SocialProfiles = {}, now = Date.now()) {
  return [
    `Preparar a legenda (não poste nada) — id: ${post.id}`,
    `Rede: ${NETWORK_NAME[post.network]}`,
    `Nome do arquivo: ${post.name}`,
    ...videoLines(post),
    `Observações: ${post.notes || "(nenhuma)"}`,
    ...profileLines(post, profiles, now, true),
  ].join("\n")
}

/** The stills as prompt parts, only when the caption is still to be written; the server reads each file into the message. */
export function frameParts(post: SocialPost) {
  return (post.frames ?? []).map((frame, index) => ({
    type: "file" as const,
    mime: "image/jpeg",
    filename: `quadro-${index + 1}.jpg`,
    url: fileURL(frame),
  }))
}

function videoLines(post: SocialPost) {
  const size = post.width && post.height ? `${post.width}×${post.height}` : undefined
  const shape = !post.width || !post.height ? undefined : post.height > post.width ? "vertical" : post.height < post.width ? "horizontal" : "quadrado"
  const details = [post.duration ? `${Math.round(post.duration)} s` : undefined, shape && `${shape} (${size})`].filter(Boolean)
  return [
    ...(details.length ? [`Duração e formato: ${details.join(", ")}`] : []),
    post.frames?.length
      ? `Quadros do vídeo em anexo: ${post.frames.length}, em ordem.`
      : "Sem quadros do vídeo: use as observações e o nome do arquivo.",
  ]
}

function profileLines(post: SocialPost, profiles: SocialProfiles, now: number, read: boolean) {
  const profile = profiles[post.network]
  if (profile && now - profile.updated < PROFILE_FRESH_MS) return [`Resumo do perfil:\n${profile.summary}`]
  return read ? ["Resumo do perfil: (nenhum ainda, leia o perfil)"] : []
}

function fileURL(file: string) {
  const slashed = file.replaceAll("\\", "/")
  return `file://${slashed.startsWith("/") ? "" : "/"}${encodeURI(slashed)}`
}
