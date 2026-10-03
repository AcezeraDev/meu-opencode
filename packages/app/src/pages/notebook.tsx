import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerJson } from "@/utils/server-json"
import { showToast } from "@/utils/toast"
import "./notebook.css"

type Subject = { slug: string; subject: string; count: number; updated: number }
type Entry = { time: number; place: string; activity: string; answer: string; why: string; url: string }
type Page = { subject: string; entries: Entry[] }

/**
 * The study notebook: the answers the agent explained on course pages, by
 * subject and by week, to read back before a test. Kept by the server while
 * "Explain each answer" is on.
 */
export function NotebookPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const platform = usePlatform()
  const json = useServerJson()
  const [chosen, setChosen] = createSignal<string>()

  const [subjects] = createResource(() => json<Subject[]>("/experimental/notebook").then((list) => list ?? []), {
    initialValue: [],
  })
  const current = createMemo(() => chosen() ?? subjects.latest[0]?.slug)
  const [page] = createResource(current, (slug) => json<Page>(`/experimental/notebook/${encodeURIComponent(slug)}`), {
    initialValue: undefined,
  })

  // Entries by where they were on the course, in the order they were answered.
  const groups = createMemo(() => {
    const map = new Map<string, Entry[]>()
    for (const entry of page.latest?.entries ?? []) {
      const key = entry.place || language.t("notebook.noPlace")
      const list = map.get(key)
      if (list) {
        list.push(entry)
        continue
      }
      map.set(key, [entry])
    }
    return [...map.entries()]
  })

  const asText = () => {
    const current = page.latest
    if (!current) return ""
    return [
      `# ${current.subject}`,
      ...groups().flatMap(([place, entries]) => [
        "",
        `## ${place}`,
        ...entries.flatMap((entry) => ["", `### ${entry.activity}`, `**${entry.answer}** — ${entry.why}`]),
      ]),
    ].join("\n")
  }

  const copy = async () => {
    await navigator.clipboard.writeText(asText()).catch(() => undefined)
    showToast({ title: language.t("notebook.copied") })
  }

  const date = (time: number) =>
    new Intl.DateTimeFormat(language.intl(), { day: "2-digit", month: "short" }).format(new Date(time))

  return (
    <main class="notebook-page">
      <header class="notebook-header">
        <button
          class="notebook-back"
          type="button"
          aria-label={language.t("agents.back")}
          onClick={() => navigate("/")}
        >
          <Icon name="arrow-left" />
        </button>
        <div>
          <h1>{language.t("notebook.title")}</h1>
          <p>{language.t("notebook.subtitle")}</p>
        </div>
        <Show when={page.latest}>
          <ButtonV2 variant="ghost" onClick={() => void copy()}>
            {language.t("notebook.copy")}
          </ButtonV2>
        </Show>
      </header>

      <Show
        when={subjects.latest.length > 0}
        fallback={
          <div class="notebook-empty">
            <p>{subjects.loading ? language.t("notebook.loading") : language.t("notebook.empty")}</p>
          </div>
        }
      >
        <div class="notebook-workspace">
          <nav class="notebook-subjects" aria-label={language.t("notebook.subjects")}>
            <For each={subjects.latest}>
              {(subject) => (
                <button
                  type="button"
                  class="notebook-subject"
                  aria-current={current() === subject.slug ? "page" : undefined}
                  onClick={() => setChosen(subject.slug)}
                >
                  <span class="notebook-subject-name">{subject.subject}</span>
                  <span class="notebook-subject-meta">
                    {language.t("notebook.count", { count: subject.count })} · {date(subject.updated)}
                  </span>
                </button>
              )}
            </For>
          </nav>

          <section class="notebook-entries">
            <Show when={page.latest}>{(current) => <h2 class="notebook-subject-title">{current().subject}</h2>}</Show>
            <For each={groups()}>
              {([place, entries]) => (
                <section class="notebook-group">
                  <h3>{place}</h3>
                  <For each={entries}>
                    {(entry) => (
                      <article class="notebook-entry">
                        <header>
                          <span class="notebook-entry-activity">{entry.activity}</span>
                          <button
                            type="button"
                            class="notebook-entry-open"
                            onClick={() => platform.openExternal(entry.url)}
                          >
                            {language.t("notebook.open")}
                          </button>
                        </header>
                        <p class="notebook-entry-answer">{entry.answer}</p>
                        <p class="notebook-entry-why">{entry.why}</p>
                      </article>
                    )}
                  </For>
                </section>
              )}
            </For>
          </section>
        </div>
      </Show>
    </main>
  )
}
