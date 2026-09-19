import { createEffect, createMemo, createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createEventListener } from "@solid-primitives/event-listener"
import { Icon } from "@opencode-ai/ui/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import type { PromptInputV2Attachment } from "@opencode-ai/session-ui/v2/prompt-input"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { handleDocumentSearchKeydown } from "@/utils/search-keydown"
import { returnFocus } from "./permission-mode"
import "./skill-picker.css"

export type SkillInfo = { name: string; description?: string; location: string; content: string }

// Skills ride along as text attachments, so the chat shows each one as a "SKILL" card
// and the server hands its content to the model like any attached file.
const SUFFIX = ".skill"

export function skillFilename(name: string) {
  return `${name}${SUFFIX}`
}

/** What the model reads for an attached skill, in the shape the skill tool returns. */
export function skillAttachmentText(skill: SkillInfo) {
  const dir = skill.location === "<built-in>" ? undefined : skill.location.replace(/[\\/][^\\/]*$/, "")
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    "The user attached this skill to their message. Follow its instructions for this request.",
    "",
    skill.content.trim(),
    ...(dir
      ? [
          "",
          `Base directory for this skill: ${dir}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
        ]
      : []),
    "</skill_content>",
  ].join("\n")
}

/** The skills this composer can attach, and which of them are attached right now. */
export function createSkillAttachments(input: {
  attachments: () => PromptInputV2Attachment[]
  add: (files: File[]) => void
  remove: (id: string) => void
}) {
  const sdk = useSDK()
  const [skills, { refetch }] = createResource(
    () => sdk().directory,
    (directory) =>
      sdk()
        .client.app.skills({ directory })
        .then((result) => (result.data ?? []) as SkillInfo[])
        .catch(() => [] as SkillInfo[]),
  )
  const attached = createMemo(() => input.attachments().filter((item) => item.filename.endsWith(SUFFIX)))
  const selected = createMemo(() => new Set(attached().map((item) => item.filename.slice(0, -SUFFIX.length))))

  return {
    list: () => skills.latest ?? [],
    loading: () => skills.loading && !skills.latest,
    refresh: () => void refetch(),
    selected,
    toggle(skill: SkillInfo) {
      const existing = attached().find((item) => item.filename === skillFilename(skill.name))
      if (existing) {
        input.remove(existing.id)
        return
      }
      input.add([new File([skillAttachmentText(skill)], skillFilename(skill.name), { type: "text/plain" })])
    },
    clear() {
      for (const item of attached()) input.remove(item.id)
    },
  }
}

export type SkillAttachments = ReturnType<typeof createSkillAttachments>

export function SkillPickerControl(props: { skills: SkillAttachments; onClose?: () => void }) {
  const language = useLanguage()
  const [store, setStore] = createStore({ open: false, search: "", active: "" })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined

  const matches = (search: string) => {
    const query = search.trim().toLowerCase()
    const list = [...props.skills.list()].sort((a, b) => a.name.localeCompare(b.name))
    if (!query) return list
    // Name hits first, then description hits; the sort is stable, so each group stays alphabetical.
    const rank = (skill: SkillInfo) => {
      const name = skill.name.toLowerCase()
      if (name.startsWith(query)) return 0
      if (name.includes(query)) return 1
      if (skill.description?.toLowerCase().includes(query)) return 2
      return 3
    }
    return list
      .map((skill) => ({ skill, rank: rank(skill) }))
      .filter((item) => item.rank < 3)
      .sort((a, b) => a.rank - b.rank)
      .map((item) => item.skill)
  }
  const filtered = createMemo(() => matches(store.search))
  const count = () => props.skills.selected().size

  const activeItem = () =>
    store.active ? contentRef?.querySelector<HTMLElement>(`[data-skill="${CSS.escape(store.active)}"]`) : undefined
  const setSearch = (value: string) => setStore({ search: value, active: matches(value)[0]?.name ?? "" })
  const setOpen = (open: boolean) => {
    if (open) {
      props.skills.refresh()
      setStore({ open: true, search: "", active: matches("")[0]?.name ?? "" })
      setTimeout(() => requestAnimationFrame(() => searchRef?.focus()))
      return
    }
    setStore({ open: false, search: "", active: "" })
  }
  const move = (delta: 1 | -1) => {
    const list = filtered()
    if (list.length === 0) return
    const index = list.findIndex((skill) => skill.name === store.active)
    const next = index === -1 ? (delta > 0 ? 0 : list.length - 1) : (index + delta + list.length) % list.length
    setStore("active", list[next].name)
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }
  const toggleActive = () => {
    const skill = filtered().find((item) => item.name === store.active)
    if (skill) props.skills.toggle(skill)
  }

  // Typing anywhere in the open menu goes to the search box, like the model picker.
  createEffect(() => {
    if (!store.open) return
    createEventListener(
      document,
      "keydown",
      (event: KeyboardEvent) => handleDocumentSearchKeydown(searchRef, event, store.search, setSearch),
      true,
    )
  })

  return (
    <TooltipV2 placement="top" gutter={4} value={language.t("ui.skillPicker.tooltip")} inactive={store.open}>
      <MenuV2 open={store.open} onOpenChange={setOpen} gutter={6} modal={false} placement="top-start">
        <MenuV2.Trigger
          as={ButtonV2}
          variant="ghost-muted"
          size="normal"
          data-action="prompt-skills"
          data-selected={count() > 0 ? "" : undefined}
          class="min-w-0 max-w-[160px] justify-start ![font-weight:440]"
          style={{ height: "28px" }}
          aria-label={language.t("ui.skillPicker.tooltip")}
        >
          <Icon name="checklist" size="small" class="shrink-0" />
          <span class="truncate leading-5">{language.t("ui.skillPicker.label")}</span>
          <Show when={count() > 0}>
            <span data-slot="skill-picker-count">{count()}</span>
          </Show>
          <span class="-ms-0.5 -me-1 flex shrink-0">
            <IconV2 name="chevron-down" />
          </span>
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content
            ref={(element: HTMLDivElement) => (contentRef = element)}
            data-slot="skill-picker-menu"
            onCloseAutoFocus={(event: Event) => returnFocus(event, props.onClose)}
          >
            <div data-slot="skill-picker-search">
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <input
                ref={(element) => (searchRef = element)}
                value={store.search}
                placeholder={language.t("ui.skillPicker.search")}
                aria-label={language.t("ui.skillPicker.search")}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                onInput={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Tab") return
                  event.stopPropagation()
                  if (event.key === "Escape") {
                    event.preventDefault()
                    setOpen(false)
                    return
                  }
                  if (event.altKey || event.metaKey) return
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    move(1)
                    return
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault()
                    move(-1)
                    return
                  }
                  if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault()
                    toggleActive()
                  }
                }}
              />
            </div>
            <div data-slot="skill-picker-divider" />
            <ScrollView data-slot="skill-picker-scroll" class="max-h-[320px] min-h-0">
              <div class="flex flex-col p-0.5">
                <Show
                  when={filtered().length > 0}
                  fallback={
                    <div data-slot="skill-picker-empty">
                      <Show
                        when={!props.skills.loading()}
                        fallback={<span>{language.t("ui.skillPicker.loading")}</span>}
                      >
                        <span>{language.t("ui.skillPicker.empty")}</span>
                        <Show when={!store.search.trim()}>
                          <span data-slot="skill-picker-hint">{language.t("ui.skillPicker.emptyHint")}</span>
                        </Show>
                      </Show>
                    </div>
                  }
                >
                  <For each={filtered()}>
                    {(skill) => (
                      <MenuV2.CheckboxItem
                        checked={props.skills.selected().has(skill.name)}
                        onChange={() => props.skills.toggle(skill)}
                        closeOnSelect={false}
                        data-slot="skill-picker-item"
                        data-skill={skill.name}
                        classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === skill.name }}
                        onMouseEnter={() => {
                          setStore("active", skill.name)
                          setTimeout(() => searchRef?.focus())
                        }}
                      >
                        <span data-slot="skill-picker-text">
                          <span data-slot="skill-picker-name">{skill.name}</span>
                          <Show when={skill.description}>
                            <span data-slot="skill-picker-description">{skill.description}</span>
                          </Show>
                        </span>
                      </MenuV2.CheckboxItem>
                    )}
                  </For>
                </Show>
              </div>
            </ScrollView>
            <Show when={count() > 0}>
              <div data-slot="skill-picker-divider" />
              <div data-slot="skill-picker-footer">
                <span>{language.t("ui.skillPicker.selected", { count: count() })}</span>
                <button
                  type="button"
                  data-action="skill-picker-clear"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => props.skills.clear()}
                >
                  {language.t("ui.skillPicker.clear")}
                </button>
              </div>
            </Show>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </TooltipV2>
  )
}
