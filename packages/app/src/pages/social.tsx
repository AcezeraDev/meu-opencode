import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { useServerJson } from "@/utils/server-json"
import { NETWORK_NAME, PREPARE_MS, type SocialNetwork, type SocialPost, type SocialQueue } from "./layout/social-clock"
import "./notebook.css"
import "./social.css"

type Draft = {
  key: number
  source: string
  /** The path came from the dropped file itself, so there is nothing to type. */
  known: boolean
  name: string
  at: string
  networks: SocialNetwork[]
  notes: string
  own: boolean
  caption: string
}

const HOUR = 60 * 60 * 1000
const NETWORKS: SocialNetwork[] = ["instagram", "tiktok"]
/** How many stills are taken from each video for the model to look at. */
const STILLS = 6

/**
 * The posting queue: the person drops videos in, says where and when each
 * goes out and what it is about, and the app's clock has the social agent
 * post them at that time through their own browser.
 */
export function SocialPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const json = useServerJson()
  const platform = usePlatform()
  const models = useModels()
  const [queue, { refetch }] = createResource(() => json<SocialQueue>("/experimental/social"), {
    initialValue: undefined,
  })
  // The clock changes posts on its own; keep the list current while it is open.
  const timer = setInterval(() => void refetch(), 10_000)
  onCleanup(() => clearInterval(timer))

  const [drafts, setDrafts] = createStore<Draft[]>([])
  // The dropped files themselves, by draft key: the stills are taken from them when scheduling.
  const dropped = new Map<number, File>()
  const [editing, setEditing] = createSignal<{ id: string; text: string }>()
  const [dragging, setDragging] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const recent = createMemo(() => models.recent.list().filter((model) => models.find(model)))
  const [model, setModel] = createSignal<string>()
  const chosenModel = createMemo(() => {
    const key = model() ?? (recent()[0] ? `${recent()[0].providerID}/${recent()[0].modelID}` : "")
    const found = recent().find((item) => `${item.providerID}/${item.modelID}` === key)
    return found ? { providerID: found.providerID, modelID: found.modelID } : undefined
  })

  // Kept by id across refetches, so a row (and a caption being edited in it) is not rebuilt every ten seconds.
  const [shown, setShown] = createStore<{ posts: SocialPost[] }>({ posts: [] })
  createEffect(() => setShown("posts", reconcile(queue.latest?.posts ?? [], { key: "id" })))
  const posts = () => shown.posts
  const upcoming = createMemo(() => posts().filter((post) => post.status === "scheduled" || post.status === "producing"))
  const finished = createMemo(() =>
    posts()
      .filter((post) => post.status === "posted" || post.status === "failed")
      .toSorted((a, b) => b.updated - a.updated),
  )

  const addFiles = (files: File[]) => {
    // Each new video goes an hour after the last one, so a batch spreads out by itself.
    const last = Math.max(Date.now(), ...posts().map((post) => post.at), ...drafts.map((draft) => toTime(draft.at)))
    const first = Math.ceil((last + HOUR / 2) / HOUR) * HOUR
    setDrafts(
      produce((list) => {
        files.forEach((file, index) => {
          const key = Date.now() + index + Math.random()
          dropped.set(key, file)
          list.push({
            key,
            source: platform.getPathForFile?.(file) || "",
            known: !!platform.getPathForFile?.(file),
            name: file.name,
            at: toLocalInput(first + index * HOUR),
            networks: ["instagram"],
            notes: "",
            own: false,
            caption: "",
          })
        })
      }),
    )
  }

  const schedule = async () => {
    setBusy(true)
    setProblem(undefined)
    const failed: string[] = []
    for (const draft of [...drafts]) {
      const file = dropped.get(draft.key)
      const stills = file ? await videoStills(file) : {}
      const saved = await json<SocialPost[]>("/experimental/social", {}, "POST", {
        ...stills,
        source: draft.source.trim(),
        networks: draft.networks,
        at: toTime(draft.at),
        notes: draft.notes,
        caption: draft.own ? draft.caption : undefined,
        model: chosenModel(),
      })
      if (!saved) failed.push(draft.name)
      if (saved) dropped.delete(draft.key)
      if (saved) setDrafts((list) => list.filter((item) => item.key !== draft.key))
    }
    if (failed.length) setProblem(failed.map((name) => language.t("social.scheduleFailed", { name })).join(" "))
    setBusy(false)
    void refetch()
  }

  const change = async (post: SocialPost, body: Record<string, unknown>) => {
    await json(`/experimental/social/${post.id}`, {}, "PATCH", body)
    void refetch()
  }
  const remove = async (post: SocialPost) => {
    await json(`/experimental/social/${post.id}`, {}, "DELETE")
    void refetch()
  }
  const openSession = (sessionID: string | undefined) => {
    const dir = queue.latest?.directory
    if (!dir || !sessionID) return
    navigate(`/${base64Encode(dir)}/session/${sessionID}`)
  }
  const saveCaption = async (post: SocialPost) => {
    const text = editing()?.text ?? ""
    setEditing(undefined)
    await change(post, { caption: text })
  }

  const ready = () =>
    drafts.length > 0 &&
    drafts.every((draft) => draft.source.trim() && draft.networks.length > 0 && !Number.isNaN(toTime(draft.at)))
  const count = () => drafts.reduce((sum, draft) => sum + draft.networks.length, 0)
  const when = (at: number) =>
    new Intl.DateTimeFormat(language.intl(), { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(at)

  let picker: HTMLInputElement | undefined

  return (
    <main
      class="notebook-page social-page"
      data-dragging={dragging() ? "" : undefined}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        addFiles(Array.from(event.dataTransfer?.files ?? []))
      }}
    >
      <header class="notebook-header">
        <button class="notebook-back" type="button" aria-label={language.t("agents.back")} onClick={() => navigate("/")}>
          <Icon name="arrow-left" />
        </button>
        <div>
          <h1>{language.t("social.title")}</h1>
          <p>{language.t("social.subtitle")}</p>
        </div>
        <div class="social-actions">
          <input
            ref={picker}
            type="file"
            accept="video/*"
            multiple
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files ?? []))
              event.currentTarget.value = ""
            }}
          />
          <ButtonV2 onClick={() => picker?.click()}>{language.t("social.add")}</ButtonV2>
        </div>
      </header>

      <div class="social-body">
        <Show
          when={drafts.length > 0}
          fallback={
            <button type="button" class="social-drop" onClick={() => picker?.click()}>
              <Icon name="cloud-upload" />
              <strong>{language.t("social.drop")}</strong>
              <span>{language.t("social.dropHint")}</span>
            </button>
          }
        >
          <section class="social-drafts">
            <For each={drafts}>
              {(draft, index) => (
                <article class="social-draft">
                  <header>
                    <strong>{draft.name}</strong>
                    <button
                      type="button"
                      class="social-link"
                      onClick={() => {
                        dropped.delete(draft.key)
                        setDrafts((list) => list.filter((item) => item.key !== draft.key))
                      }}
                    >
                      {language.t("social.draft.remove")}
                    </button>
                  </header>
                  <Show when={!draft.known}>
                    <label class="social-field">
                      <span>{language.t("social.draft.path")}</span>
                      <input
                        type="text"
                        placeholder={language.t("social.draft.pathMissing")}
                        value={draft.source}
                        onInput={(event) => setDrafts(index(), "source", event.currentTarget.value)}
                      />
                    </label>
                  </Show>
                  <div class="social-row">
                    <label class="social-field">
                      <span>{language.t("social.draft.when")}</span>
                      <input
                        type="datetime-local"
                        value={draft.at}
                        onInput={(event) => setDrafts(index(), "at", event.currentTarget.value)}
                      />
                    </label>
                    <fieldset class="social-field">
                      <span>{language.t("social.draft.networks")}</span>
                      <div class="social-networks">
                        <For each={NETWORKS}>
                          {(network) => (
                            <label class="social-chip" data-on={draft.networks.includes(network) ? "" : undefined}>
                              <input
                                type="checkbox"
                                checked={draft.networks.includes(network)}
                                onChange={(event) =>
                                  setDrafts(index(), "networks", (list) =>
                                    event.currentTarget.checked ? [...list, network] : list.filter((item) => item !== network),
                                  )
                                }
                              />
                              {NETWORK_NAME[network]}
                            </label>
                          )}
                        </For>
                      </div>
                    </fieldset>
                  </div>
                  <label class="social-field">
                    <span>{language.t("social.draft.notes")}</span>
                    <textarea
                      rows={2}
                      placeholder={language.t("social.draft.notesPlaceholder")}
                      value={draft.notes}
                      onInput={(event) => setDrafts(index(), "notes", event.currentTarget.value)}
                    />
                  </label>
                  <label class="social-check">
                    <input type="checkbox" checked={draft.own} onChange={(event) => setDrafts(index(), "own", event.currentTarget.checked)} />
                    {language.t("social.draft.ownCaption")}
                  </label>
                  <Show when={draft.own}>
                    <label class="social-field">
                      <span>{language.t("social.draft.caption")}</span>
                      <textarea rows={4} value={draft.caption} onInput={(event) => setDrafts(index(), "caption", event.currentTarget.value)} />
                    </label>
                  </Show>
                </article>
              )}
            </For>
            <footer class="social-drafts-footer">
              <label class="social-field social-model">
                <span>{language.t("social.model")}</span>
                <select
                  value={chosenModel() ? `${chosenModel()!.providerID}/${chosenModel()!.modelID}` : ""}
                  onChange={(event) => setModel(event.currentTarget.value)}
                >
                  <option value="">{language.t("social.model.default")}</option>
                  <For each={recent()}>
                    {(item) => <option value={`${item.providerID}/${item.modelID}`}>{models.find(item)?.name ?? item.modelID}</option>}
                  </For>
                </select>
              </label>
              <Show when={problem()}>
                <p class="social-problem">{problem()}</p>
              </Show>
              <ButtonV2 disabled={!ready() || busy()} onClick={() => void schedule()}>
                {language.t("social.schedule", { count: count() })}
              </ButtonV2>
            </footer>
          </section>
        </Show>

        <section class="social-list">
          <h2>{language.t("social.upcoming")}</h2>
          <Show when={upcoming().length > 0} fallback={<p class="social-empty">{language.t("social.empty")}</p>}>
            <For each={upcoming()}>
              {(post) => (
                <PostRow post={post} when={when(post.at)}>
                  <Show when={post.status === "scheduled"}>
                    <Show when={post.at <= Date.now()} fallback={
                      <button type="button" class="social-link" onClick={() => void change(post, { at: Date.now() })}>
                        {language.t("social.action.now")}
                      </button>
                    }>
                      <span class="social-late">{language.t("social.late")}</span>
                    </Show>
                    <input
                      type="datetime-local"
                      class="social-reschedule"
                      aria-label={language.t("social.action.reschedule")}
                      value={toLocalInput(post.at)}
                      onChange={(event) => {
                        const at = toTime(event.currentTarget.value)
                        if (!Number.isNaN(at)) void change(post, { at })
                      }}
                    />
                    <button type="button" class="social-link" onClick={() => void remove(post)}>
                      {language.t("social.action.remove")}
                    </button>
                  </Show>
                  <Show when={post.status === "producing"}>
                    <button type="button" class="social-link" onClick={() => openSession(post.sessionID)}>
                      {language.t("social.action.session")}
                    </button>
                  </Show>
                </PostRow>
              )}
            </For>
          </Show>

          <Show when={finished().length > 0}>
            <h2>{language.t("social.done")}</h2>
            <For each={finished()}>
              {(post) => (
                <PostRow post={post} when={when(post.updated)}>
                  <Show when={post.url}>
                    <a class="social-link" href={post.url} target="_blank" rel="noreferrer">
                      {language.t("social.action.view")}
                    </a>
                  </Show>
                  <Show when={post.sessionID}>
                    <button type="button" class="social-link" onClick={() => openSession(post.sessionID)}>
                      {language.t("social.action.session")}
                    </button>
                  </Show>
                  <Show when={post.status === "failed"}>
                    <button type="button" class="social-link" onClick={() => void change(post, { status: "scheduled", at: Date.now() })}>
                      {language.t("social.action.retry")}
                    </button>
                  </Show>
                  <button type="button" class="social-link" onClick={() => void remove(post)}>
                    {language.t("social.action.remove")}
                  </button>
                </PostRow>
              )}
            </For>
          </Show>
        </section>
      </div>
    </main>
  )

  function PostRow(props: { post: SocialPost; when: string; children: JSX.Element }) {
    const upcoming = () => props.post.status === "scheduled" || props.post.status === "producing"
    return (
      <article class="social-post" data-status={props.post.status}>
        <span class="social-network" data-network={props.post.network}>
          {NETWORK_NAME[props.post.network]}
        </span>
        <div class="social-post-main">
          <strong>{props.post.name}</strong>
          <span class="social-post-meta">
            {props.when} · {language.t(`social.status.${props.post.status}`)}
          </span>
          <Show when={props.post.error}>
            <span class="social-post-error">{props.post.error}</span>
          </Show>
          <Show when={!upcoming() && (props.post.posted ?? props.post.caption ?? props.post.draft ?? props.post.notes)}>
            {(text) => <span class="social-post-caption">{text()}</span>}
          </Show>
        </div>
        <div class="social-post-actions">{props.children}</div>
        <Show when={upcoming()}>
          <CaptionBox post={props.post} />
        </Show>
      </article>
    )
  }

  /** The caption that will go out: the person's own, the one the AI prepared, or when it will be ready. */
  function CaptionBox(props: { post: SocialPost }) {
    const post = () => props.post
    const text = () => post().caption ?? post().draft
    const open = () => post().status === "scheduled" && post().prep?.status !== "running"
    const label = () => {
      if (post().caption) return language.t("social.caption.own")
      if (post().draft) return language.t("social.caption.ai")
      if (post().prep?.status === "running") return language.t("social.caption.writing")
      if (post().prep?.status === "failed") return language.t("social.caption.prepFailed")
      if (post().status === "producing" || post().at <= Date.now()) return language.t("social.caption.atPost")
      return language.t("social.caption.later", {
        time: new Intl.DateTimeFormat(language.intl(), { hour: "2-digit", minute: "2-digit" }).format(
          post().at - PREPARE_MS,
        ),
      })
    }
    return (
      <div class="social-caption" data-kind={post().caption ? "own" : post().draft ? "ai" : "none"}>
        <div class="social-caption-head">
          <span>{label()}</span>
          <div class="social-caption-actions">
            <Show when={post().prep?.status === "running"}>
              <button type="button" class="social-link" onClick={() => openSession(post().prep?.sessionID)}>
                {language.t("social.action.session")}
              </button>
            </Show>
            <Show when={open() && editing()?.id !== post().id}>
              <Show when={text()}>
                <button
                  type="button"
                  class="social-link"
                  onClick={() => setEditing({ id: post().id, text: text() ?? "" })}
                >
                  {language.t("social.caption.edit")}
                </button>
              </Show>
              <Show when={post().at > Date.now()}>
                <button type="button" class="social-link" onClick={() => void change(post(), { prepare: true })}>
                  {text() ? language.t("social.caption.again") : language.t("social.caption.now")}
                </button>
              </Show>
            </Show>
          </div>
        </div>
        <Show
          when={editing()?.id === post().id}
          fallback={<Show when={text()}>{(caption) => <p class="social-caption-text">{caption()}</p>}</Show>}
        >
          <textarea
            class="social-caption-input"
            rows={5}
            value={editing()?.text ?? ""}
            onInput={(event) => setEditing({ id: post().id, text: event.currentTarget.value })}
          />
          <div class="social-caption-actions">
            <button type="button" class="social-link" onClick={() => setEditing(undefined)}>
              {language.t("social.caption.cancel")}
            </button>
            <ButtonV2 onClick={() => void saveCaption(post())}>{language.t("social.caption.save")}</ButtonV2>
          </div>
        </Show>
        <Show when={!post().caption && post().analysis}>
          {(analysis) => (
            <p class="social-caption-analysis">
              {language.t("social.caption.saw")} {analysis()}
            </p>
          )}
        </Show>
      </div>
    )
  }
}

function toLocalInput(time: number) {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toTime(value: string) {
  return new Date(value).getTime()
}

/**
 * Stills spread across the video, small JPEGs a model can look at, plus its
 * length and size; nothing when the video cannot be decoded here (then the
 * caption comes from the notes alone).
 */
async function videoStills(file: File) {
  const url = URL.createObjectURL(file)
  const video = document.createElement("video")
  video.muted = true
  video.preload = "auto"
  video.src = url
  const result = await readStills(video).catch(() => ({}))
  URL.revokeObjectURL(url)
  video.removeAttribute("src")
  return result
}

async function readStills(video: HTMLVideoElement) {
  await settle(video, "loadedmetadata")
  const duration = video.duration
  const width = video.videoWidth
  const height = video.videoHeight
  if (!Number.isFinite(duration) || !width || !height) return {}
  const scale = Math.min(1, 640 / Math.max(width, height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const context = canvas.getContext("2d")
  if (!context) return {}
  const frames: string[] = []
  // One seek at a time: the element shows a single frame.
  for (const index of Array.from({ length: STILLS }, (_, i) => i)) {
    video.currentTime = (duration * (index + 0.5)) / STILLS
    await settle(video, "seeked")
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    frames.push(canvas.toDataURL("image/jpeg", 0.7))
  }
  return { frames, duration, width, height }
}

/** Waits for a media event, failing on an error or after 10 seconds. */
function settle(video: HTMLVideoElement, event: "loadedmetadata" | "seeked") {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 10_000)
    video.addEventListener(
      event,
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    video.addEventListener(
      "error",
      () => {
        clearTimeout(timer)
        reject(new Error("error"))
      },
      { once: true },
    )
  })
}
