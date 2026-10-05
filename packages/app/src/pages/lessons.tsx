import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useServerJson } from "@/utils/server-json"
import "./notebook.css"
import "./lessons.css"

type Lesson = { name: string; url: string; done: boolean; tracked: boolean; kind: string }
type Course = { course: string; url: string; sections: { name: string; lessons: Lesson[] }[]; error?: string }

/** Lessons sent in one go: past this the agent's context fills before the last one. */
const BATCH = 10

/**
 * The course open in the person's browser, with what is still to do: they
 * pick the pending activities and the agent does them in a row, in a new
 * conversation, starting from a clean context.
 */
export function LessonsPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const layout = useLayout()
  const json = useServerJson()
  const serverSync = useServerSync()
  const server = useServer()
  const tabs = useTabs()
  // The projects open in the sidebar; failing that, the ones the server knows, latest first.
  const projects = createMemo(() => {
    const open = layout.projects.list().map((project) => project.worktree)
    if (open.length > 0) return open
    return [...serverSync().data.project]
      .filter((project) => project.worktree !== "/")
      .sort((a, b) => b.time.updated - a.time.updated)
      .map((project) => project.worktree)
  })
  const [chosenProject, setChosenProject] = createSignal<string>()
  const directory = createMemo(() => chosenProject() ?? projects()[0])
  const [picked, setPicked] = createSignal<string[]>([])

  const [course, { refetch }] = createResource(directory, (dir) => json<Course>("/experimental/browser/lessons", { directory: dir }), {
    initialValue: undefined,
  })
  // Only what the course tracks and is not done yet; the rest is counted.
  const sections = createMemo(() =>
    (course.latest?.sections ?? [])
      .map((section) => ({
        name: section.name,
        pending: section.lessons.filter((lesson) => lesson.tracked && !lesson.done),
        done: section.lessons.filter((lesson) => lesson.tracked && lesson.done).length,
      }))
      .filter((section) => section.pending.length > 0),
  )
  const pending = createMemo(() => sections().flatMap((section) => section.pending))
  const isPicked = (url: string) => picked().includes(url)
  const toggle = (urls: string[], on: boolean) =>
    setPicked((list) => (on ? [...new Set([...list, ...urls])] : list.filter((url) => !urls.includes(url))))

  const start = () => {
    const dir = directory()
    const current = course.latest
    if (!dir || !current) return
    const chosen = sections().flatMap((section) =>
      section.pending.filter((lesson) => isPicked(lesson.url)).map((lesson) => ({ ...lesson, section: section.name })),
    )
    if (chosen.length === 0) return
    const prompt = [
      language.t("lessons.prompt", { course: current.course }),
      "",
      ...chosen.map((lesson, index) => `${index + 1}. ${lesson.section} — ${lesson.name}: ${lesson.url}`),
    ].join("\n")
    // A new conversation that sends itself, as the quick-ask box does.
    void tabs.newDraft({ server: server.key, directory: dir }, prompt, undefined, true)
  }

  const kind = (value: string) => {
    const key = `lessons.kind.${value}`
    const label = language.t(key as Parameters<typeof language.t>[0])
    return label === key ? value : label
  }
  const message = () => {
    const error = course.latest?.error
    if (course.loading) return language.t("lessons.loading")
    if (error === "browser") return language.t("lessons.noBrowser")
    if (error === "index" || error === "page") return language.t("lessons.noCourse")
    if (!course.latest) return language.t("lessons.noBrowser")
    return language.t("lessons.allDone")
  }

  return (
    <main class="notebook-page lessons-page">
      <header class="notebook-header">
        <button class="notebook-back" type="button" aria-label={language.t("agents.back")} onClick={() => navigate("/")}>
          <Icon name="arrow-left" />
        </button>
        <div>
          <h1>{course.latest?.course || language.t("lessons.title")}</h1>
          <p>{language.t("lessons.subtitle")}</p>
        </div>
        <div class="lessons-actions">
          <Show when={projects().length > 1}>
            <select
              class="lessons-project"
              aria-label={language.t("lessons.project")}
              value={directory()}
              onChange={(event) => setChosenProject(event.currentTarget.value)}
            >
              <For each={projects()}>{(project) => <option value={project}>{project.split(/[\\/]/).pop()}</option>}</For>
            </select>
          </Show>
          <ButtonV2 variant="ghost" onClick={() => void refetch()}>
            {language.t("lessons.refresh")}
          </ButtonV2>
          <ButtonV2 disabled={picked().length === 0 || picked().length > BATCH} onClick={start}>
            {language.t("lessons.start", { count: picked().length })}
          </ButtonV2>
        </div>
      </header>

      <Show when={pending().length > 0} fallback={<div class="notebook-empty"><p>{message()}</p></div>}>
        <section class="lessons-list">
          <p class="lessons-summary">
            {picked().length > BATCH
              ? language.t("lessons.tooMany", { max: BATCH })
              : language.t("lessons.summary", { count: pending().length })}
          </p>
          <For each={sections()}>
            {(section) => {
              const urls = () => section.pending.map((lesson) => lesson.url)
              const all = () => urls().every(isPicked)
              return (
                <section class="lessons-section">
                  <label class="lessons-section-head">
                    <input type="checkbox" checked={all()} onChange={(event) => toggle(urls(), event.currentTarget.checked)} />
                    <span class="lessons-section-name">{section.name}</span>
                    <Show when={section.done > 0}>
                      <span class="lessons-section-done">{language.t("lessons.done", { count: section.done })}</span>
                    </Show>
                  </label>
                  <For each={section.pending}>
                    {(lesson) => (
                      <label class="lessons-item">
                        <input
                          type="checkbox"
                          checked={isPicked(lesson.url)}
                          onChange={(event) => toggle([lesson.url], event.currentTarget.checked)}
                        />
                        <span class="lessons-item-name">{lesson.name}</span>
                        <span class="lessons-item-kind">{kind(lesson.kind)}</span>
                      </label>
                    )}
                  </For>
                </section>
              )
            }}
          </For>
        </section>
      </Show>
    </main>
  )
}
