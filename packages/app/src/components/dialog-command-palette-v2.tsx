import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Dialog, DialogBody } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { commandPaletteOptions, formatKeybindParts, useCommand } from "@/context/command"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"
import { getRelativeTime } from "@/utils/time"
import {
  createCommandPaletteCommandEntry,
  createCommandPaletteFileEntry,
  createCommandPaletteModel,
  createServerSessionEntries,
  uniqueCommandPaletteEntries,
  type CommandPaletteEntry,
} from "./command-palette"
import "./dialog-command-palette-v2.css"
import { flipList } from "@/utils/motion"
import { useLynxPrefs } from "@/context/lynx-prefs"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import {
  fuzzy,
  inScope,
  Lit,
  PREFIXES,
  quickAnswer,
  readScope,
  stepEntries,
  useLynxSteps,
  type PaletteStep,
} from "./lynx-palette"
import "./lynx-palette.css"

function groups(entries: CommandPaletteEntry[]) {
  const map = new Map<string, CommandPaletteEntry[]>()
  for (const entry of entries) map.set(entry.category, [...(map.get(entry.category) ?? []), entry])
  return Array.from(map.entries()).map(([category, entries]) => ({ category, entries }))
}

function matchesEntry(entry: CommandPaletteEntry, query: string) {
  const value = query.toLowerCase()
  if ([entry.title, entry.description, entry.category].some((text) => text?.toLowerCase().includes(value))) return true
  // Letters in order, with gaps: "nvss" finds "Nova sessão".
  return value.length >= 3 && fuzzy(entry.title, value) !== undefined
}

// Ordered: specific ids before their prefix group.
const PALETTE_ICONS = [
  ["session.new", "plus"],
  ["session.archive", "archive"],
  ["session.share", "outline-share"],
  ["session.unshare", "outline-share"],
  ["session.undo", "reset"],
  ["session.redo", "outline-reset"],
  ["session.fork", "branch"],
  ["session.", "workspace"],
  ["workspace.new", "workspace-new"],
  ["workspace.", "workspace"],
  ["project.open", "folder-add-left"],
  ["project.", "folder"],
  ["terminal.", "monitor"],
  ["review.", "review"],
  ["fileTree.", "filetree"],
  ["file.", "filetree"],
  ["model.", "outline-sliders"],
  ["agent.", "outline-sliders"],
  ["mcp.", "outline-sliders"],
  ["provider.", "outline-sliders"],
  ["settings.", "settings-gear"],
  ["theme.", "settings-gear"],
  ["language.", "settings-gear"],
  ["server.", "monitor"],
  ["permissions.", "check"],
  ["message.", "menu"],
  ["home.", "grid-plus"],
  ["sidebar.", "sidebar-right"],
  ["tab.new", "plus"],
  ["tab.reopenClosed", "reset"],
  ["tab.close", "outline-xmark"],
  ["common.goBack", "outline-chevron-down"],
  ["common.goForward", "outline-chevron-down"],
  ["logs.", "outline-copy"],
  ["command.palette", "magnifying-glass"],
] as const

function paletteIcon(entry: CommandPaletteEntry) {
  const id = entry.option?.id ?? ""
  return PALETTE_ICONS.find(([prefix]) => id.startsWith(prefix))?.[1] ?? "grid-plus"
}

export function DialogCommandPaletteV2(props: { onOpenFile?: (path: string) => void }) {
  const palette = createCommandPaletteModel(props)
  const loadItems = async (text: string) => {
    const q = text.trim()
    if (!q) return [...palette.preferredCommandEntries(), ...palette.recentFileEntries()]

    const [files, nextSessions] = await Promise.all([palette.file.searchFiles(q), Promise.resolve(palette.sessions(q))])
    const category = palette.language.t("palette.group.files")
    return [
      ...palette.commandEntries().filter((entry) => matchesEntry(entry, q)),
      ...nextSessions,
      ...files.map((path) => createCommandPaletteFileEntry(path, category)),
    ]
  }

  const tabs = useTabs()
  const sdk = useSDK()
  const serverSdk = useServerSDK()
  return (
    <CommandPaletteView
      placeholder={palette.language.t("palette.search.placeholder")}
      loadItems={loadItems}
      highlight={palette.highlight}
      select={palette.select}
      close={palette.close}
      onAsk={(text) => void tabs.newDraft({ server: ServerConnection.key(serverSdk().server), directory: sdk().directory }, text)}
    />
  )
}

export function DialogHomeCommandPaletteV2(props: {
  server: ServerConnection.Any
  onSelectSession: (entry: CommandPaletteEntry) => void
}) {
  const command = useCommand()
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const serverCtx = global.ensureServerCtx(props.server)
  const state = { cleanup: undefined as (() => void) | void, committed: false }
  const commandEntries = createMemo(() => {
    const category = language.t("palette.group.commands")
    return commandPaletteOptions(command.options).map((option) => createCommandPaletteCommandEntry(option, category))
  })
  const sessions = createServerSessionEntries({
    server: ServerConnection.key(props.server),
    opened: serverCtx.projects.list,
    stored: () => serverCtx.sync.data.project,
    load: (search, signal) => serverCtx.sdk.api.session.list({ parentID: null, search, limit: 50 }, { signal }),
    untitled: () => language.t("command.session.new"),
    category: () => language.t("command.category.session"),
  })

  const highlight = (item: CommandPaletteEntry | undefined) => {
    state.cleanup?.()
    state.cleanup = undefined
    if (item?.type !== "command") return
    state.cleanup = item.option?.onHighlight?.()
  }
  const select = (item: CommandPaletteEntry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = undefined
    dialog.close()
    if (item.type === "command") {
      item.option?.onSelect?.("palette")
      return
    }
    if (item.type === "session") props.onSelectSession(item)
  }
  const loadItems = async (text: string) => {
    const query = text.trim()
    if (!query) return commandEntries().slice(0, 5)
    return [...commandEntries().filter((entry) => matchesEntry(entry, query)), ...(await sessions(query))]
  }

  onCleanup(() => {
    if (state.committed) return
    state.cleanup?.()
  })

  return (
    <CommandPaletteView
      placeholder={language.t("palette.search.placeholder.home")}
      loadItems={loadItems}
      highlight={highlight}
      select={select}
      close={() => dialog.close()}
    />
  )
}

function CommandPaletteView(props: {
  placeholder: string
  loadItems: (text: string) => CommandPaletteEntry[] | Promise<CommandPaletteEntry[]>
  highlight: (item: CommandPaletteEntry | undefined) => void
  select: (item: CommandPaletteEntry | undefined) => void
  close: () => void
  /** Sends a question to Lynx in a new session; absent where there is no project to ask in. */
  onAsk?: (text: string) => void
}) {
  const language = useLanguage()
  const tabs = useTabs()
  const prefs = useLynxPrefs()
  const steps = useLynxSteps()
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [step, setStep] = createSignal<PaletteStep>()
  const [option, setOption] = createSignal(0)
  const [numbers, setNumbers] = createSignal(false)
  let input: HTMLInputElement | undefined

  const parsed = createMemo(() => readScope(query()))
  const [entries] = createResource(
    () => parsed().rest,
    (text) => props.loadItems(text),
    { initialValue: [] as CommandPaletteEntry[] },
  )
  // Render stale results while a new query loads to avoid flashing "Loading" per keystroke.
  const visibleEntries = createMemo(() => {
    const { scope, rest } = parsed()
    if (scope === "ask") return []
    const loaded = uniqueCommandPaletteEntries(entries.latest ?? []).filter((entry) => inScope(entry, scope))
    const extra =
      scope === "all" || scope === "commands"
        ? stepEntries(steps, "Lynx Code").filter((entry) => !rest || fuzzy(entry.title, rest))
        : []
    return [...loaded, ...extra]
  })
  const groupedEntries = createMemo(() => groups(visibleEntries()))
  const activeEntry = createMemo(() => visibleEntries()[active()])
  const answer = createMemo(() => (parsed().scope === "ask" ? quickAnswer(parsed().rest) : undefined))
  const openSessions = createMemo(
    () => new Set(tabs.store.flatMap((tab) => (tab.type === "session" ? [`${tab.server}\0${tab.sessionId}`] : []))),
  )

  createEffect(() => {
    query()
    visibleEntries()
    setActive(0)
  })

  createEffect(() => {
    const entry = activeEntry()
    props.highlight(entry?.id.startsWith("lynx.step.") ? undefined : entry)
  })

  let resultsRef: HTMLDivElement | undefined

  const move = (delta: -1 | 1) => {
    const count = visibleEntries().length
    if (count === 0) return
    setActive((index) => (index + delta + count) % count)
    requestAnimationFrame(() => {
      resultsRef?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" })
    })
  }

  // A step entry opens its choices inside the palette instead of running a command.
  const choose = (entry: CommandPaletteEntry | undefined) => {
    if (entry?.id.startsWith("lynx.step.")) {
      const next = entry.id.slice("lynx.step.".length) as PaletteStep
      setStep(next)
      setOption(Math.max(0, steps[next].options.findIndex((item) => item.on)))
      setQuery("")
      input?.focus()
      return
    }
    props.select(entry)
  }
  const pickOption = (index: number) => {
    const current = step()
    if (!current) return
    steps[current].options[index]?.pick()
    props.close()
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Alt") setNumbers(true)
    if (event.altKey && /^[1-9]$/.test(event.key)) {
      event.preventDefault()
      choose(visibleEntries()[Number(event.key) - 1])
      return
    }
    const current = step()
    if (current) {
      const count = steps[current].options.length
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault()
        setOption((index) => (index + 1) % count)
        return
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault()
        setOption((index) => (index - 1 + count) % count)
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        pickOption(option())
        return
      }
      if ((event.key === "Backspace" && !query()) || event.key === "Escape") {
        event.preventDefault()
        setStep(undefined)
        return
      }
      return
    }
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
    if (event.key === "Enter") {
      event.preventDefault()
      if (parsed().scope === "ask") {
        if (parsed().rest && props.onAsk) {
          props.onAsk(parsed().rest)
          props.close()
        }
        return
      }
      choose(activeEntry())
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      props.close()
    }
  }

  const setScope = (char: string) => {
    setQuery(char ? `${char} ${parsed().rest}`.trimEnd() + (parsed().rest ? "" : " ") : parsed().rest)
    input?.focus()
  }
  const index = (entry: CommandPaletteEntry) => visibleEntries().findIndex((item) => item.id === entry.id)

  return (
    <Dialog
      // The dialog passes on its class, not data attributes, so the looks are classes.
      class={`command-palette-v2 lynx-palette lynx-layout-${prefs.get("paletteLayout")}${prefs.get("paletteGrid") ? " lynx-grid" : ""}${numbers() ? " lynx-numbers" : ""}`}
      size="large"
    >
      <DialogBody class="command-palette-v2-body">
        <div class="lynx-palette-scopes" role="tablist">
          <For each={PREFIXES}>
            {(prefix) => (
              <button
                type="button"
                role="tab"
                aria-selected={!step() && parsed().scope === prefix.scope}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setStep(undefined)
                  setScope(prefix.char)
                }}
              >
                <Show when={prefix.char}>
                  <b>{prefix.char}</b>
                </Show>
                {language.t(`lynx.palette.scope.${prefix.scope}` as never)}
              </button>
            )}
          </For>
        </div>
        <div class="command-palette-v2-search">
          <Show when={step()}>
            {(current) => (
              <span class="lynx-palette-crumb" data-motion="l">
                {steps[current()].title} ›
              </span>
            )}
          </Show>
          <TextInputV2
            ref={(el: HTMLInputElement) => (input = el)}
            value={query()}
            autofocus
            autocomplete="off"
            spellcheck={false}
            appearance="large"
            placeholder={step() ? language.t("lynx.palette.step.hint") : props.placeholder}
            leadingIcon={<Icon name="magnifying-glass" />}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            onKeyUp={(event) => event.key === "Alt" && setNumbers(false)}
            onBlur={() => setNumbers(false)}
          />
        </div>
        <Switch
          fallback={
            <div class="lynx-palette-body">
              <ScrollView class="command-palette-v2-scroll" viewportRef={(el) => (resultsRef = el)}>
                <Show when={!query() && visibleEntries().length > 2}>
                  <div class="lynx-palette-fan" aria-hidden="true">
                    <For each={visibleEntries().slice(0, 4)}>
                      {(entry, position) => (
                        <button
                          type="button"
                          tabIndex={-1}
                          class="lynx-palette-card"
                          style={{ "--i": String(position()) }}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => choose(entry)}
                        >
                          <b>{entry.title}</b>
                          <small>{entry.category}</small>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
                <div class="command-palette-v2-results" role="listbox" ref={(el) => onMount(() => onCleanup(flipList(el)))}>
                  <Show
                    when={visibleEntries().length > 0}
                    fallback={
                      <div class="command-palette-v2-state">
                        {entries.loading ? language.t("common.loading") : language.t("palette.empty")}
                      </div>
                    }
                  >
                    <For each={groupedEntries()}>
                      {(group) => (
                        <div class="command-palette-v2-group">
                          <Show when={group.category}>
                            <div class="command-palette-v2-group-title">{group.category}</div>
                          </Show>
                          <div class="lynx-palette-items">
                            <For each={group.entries}>
                              {(item) => (
                                <PaletteRow
                                  item={item}
                                  query={parsed().rest}
                                  number={index(item) < 9 ? index(item) + 1 : undefined}
                                  active={activeEntry()?.id === item.id}
                                  language={language}
                                  sessionOpen={
                                    item.server && item.sessionID
                                      ? openSessions().has(`${item.server}\0${item.sessionID}`)
                                      : false
                                  }
                                  onActive={() => setActive(index(item))}
                                  onSelect={() => choose(item)}
                                />
                              )}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </ScrollView>
              <Show when={activeEntry() && !prefs.get("paletteGrid")}>
                <PalettePreview entry={activeEntry()!} />
              </Show>
            </div>
          }
        >
          <Match when={step()}>
            {(current) => (
              <div class="lynx-carousel" data-motion="l">
                <div class="lynx-carousel-track" style={{ "--at": String(option()) }}>
                  <For each={steps[current()].options}>
                    {(item, position) => (
                      <button
                        type="button"
                        class="lynx-carousel-card"
                        data-focus={position() === option() ? "" : undefined}
                        data-on={item.on ? "" : undefined}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setOption(position())}
                        onClick={() => pickOption(position())}
                      >
                        <span class="lynx-carousel-art" data-id={item.id} />
                        <b>{item.label}</b>
                        <Show when={item.hint}>
                          <small>{item.hint}</small>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Match>
          <Match when={parsed().scope === "ask"}>
            <div class="lynx-palette-ask" data-motion="l">
              <Show
                when={answer()}
                fallback={
                  <p class="lynx-palette-ask-hint">
                    {parsed().rest ? language.t("lynx.palette.ask.session") : language.t("lynx.palette.ask.hint")}
                  </p>
                }
              >
                {(value) => (
                  <>
                    <span class="lynx-palette-ask-label">{language.t("lynx.palette.ask.answer")}</span>
                    <b class="lynx-palette-ask-value">{value()}</b>
                    <small>{parsed().rest}</small>
                  </>
                )}
              </Show>
              <Show when={parsed().rest && props.onAsk}>
                <button
                  type="button"
                  class="lynx-palette-ask-go"
                  onClick={() => {
                    props.onAsk?.(parsed().rest)
                    props.close()
                  }}
                >
                  {language.t("lynx.palette.ask.go")} <KeybindV2 keys={["↵"]} variant="neutral" />
                </button>
              </Show>
            </div>
          </Match>
        </Switch>
        <div class="command-palette-v2-footer">
          <span class="command-palette-v2-hint">
            <KeybindV2 keys={["↑", "↓"]} variant="neutral" />
            {language.t("palette.hint.navigate")}
          </span>
          <span class="command-palette-v2-hint">
            <KeybindV2 keys={["↵"]} variant="neutral" />
            {language.t("palette.hint.select")}
          </span>
          <span class="command-palette-v2-hint">
            <KeybindV2 keys={["Alt", "1–9"]} variant="neutral" />
            {language.t("lynx.palette.hint.number")}
          </span>
          <span class="lynx-palette-tools">
            <button
              type="button"
              title={language.t("lynx.palette.grid")}
              aria-pressed={prefs.get("paletteGrid")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => prefs.set("paletteGrid", !prefs.get("paletteGrid"))}
            >
              ▦
            </button>
            <For each={["centro", "lado", "cortina"] as const}>
              {(layout) => (
                <button
                  type="button"
                  title={language.t(`lynx.palette.layout.${layout}` as never)}
                  aria-pressed={prefs.get("paletteLayout") === layout}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => prefs.set("paletteLayout", layout)}
                >
                  {layout === "centro" ? "◻" : layout === "lado" ? "◧" : "⬒"}
                </button>
              )}
            </For>
          </span>
        </div>
      </DialogBody>
    </Dialog>
  )
}

/** The highlighted result, larger, beside the list: a session's last words, a command's shortcut, a file's place. */
function PalettePreview(props: { entry: CommandPaletteEntry }) {
  const language = useLanguage()
  const global = useGlobal()
  const lines = createMemo(() => {
    const entry = props.entry
    if (entry.type !== "session" || !entry.server || !entry.sessionID) return []
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === entry.server)
    if (!conn) return []
    const store = global.ensureServerCtx(conn).sync
    void store.session.sync(entry.sessionID).catch(() => undefined)
    return (store.session.data.message[entry.sessionID] ?? []).slice(-4).flatMap((message) => {
      const text = (store.session.data.part[message.id] ?? [])
        .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
        .join(" ")
      return text ? [{ role: message.role, text: text.length > 180 ? `${text.slice(0, 180)}…` : text }] : []
    })
  })
  return (
    <aside class="lynx-palette-preview" data-motion="l">
      <span class="lynx-palette-preview-kind">{props.entry.category}</span>
      <b>{props.entry.title}</b>
      <Show when={props.entry.description}>
        <p>{props.entry.description}</p>
      </Show>
      <Show when={props.entry.type === "file" && props.entry.path}>
        <code>{props.entry.path}</code>
      </Show>
      <Show when={props.entry.keybind}>
        <KeybindV2 keys={formatKeybindParts(props.entry.keybind ?? "", language.t)} variant="neutral" />
      </Show>
      <For each={lines()}>{(line) => <p data-role={line.role}>{line.text}</p>}</For>
    </aside>
  )
}

function PaletteRow(props: {
  item: CommandPaletteEntry
  query: string
  number?: number
  active: boolean
  language: ReturnType<typeof useLanguage>
  sessionOpen: boolean
  onActive: () => void
  onSelect: () => void
}) {
  const session = () =>
    props.item.server && props.item.directory && props.item.sessionID
      ? { server: props.item.server, directory: props.item.directory, sessionID: props.item.sessionID }
      : undefined

  return (
    <button
      type="button"
      class="command-palette-v2-row group"
      data-flip-key={props.item.id}
      role="option"
      aria-selected={props.active}
      data-active={props.active ? "" : undefined}
      onMouseMove={(event) => {
        // Ignore hover from a static cursor when keyboard scrolling moves rows underneath it.
        if (event.movementX === 0 && event.movementY === 0) return
        props.onActive()
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onSelect}
    >
      <Show when={props.number}>
        <span class="lynx-palette-number" aria-hidden="true">
          {props.number}
        </span>
      </Show>
      <Switch
        fallback={
          <div class="command-palette-v2-row-main">
            <FileIcon node={{ path: props.item.path ?? "", type: "file" }} class="command-palette-v2-row-icon size-4" />
            <div class="command-palette-v2-file-path">
              <span class="command-palette-v2-file-dir">{getDirectory(props.item.path ?? "")}</span>
              <span class="command-palette-v2-file-name">
                <Lit text={getFilename(props.item.path ?? "")} query={props.query} />
              </span>
            </div>
          </div>
        }
      >
        <Match when={props.item.type === "command"}>
          <div class="command-palette-v2-row-main">
            <span class="command-palette-v2-row-tile" data-command={props.item.option?.id}>
              <Icon name={props.item.id.startsWith("lynx.step.") ? "outline-sliders" : paletteIcon(props.item)} />
            </span>
            <div class="command-palette-v2-row-text">
              <span class="command-palette-v2-title">
                <Lit text={props.item.title} query={props.query} />
              </span>
              <Show when={props.item.description}>
                <span class="command-palette-v2-description">{props.item.description}</span>
              </Show>
            </div>
          </div>
          <Show when={props.item.keybind}>
            <KeybindV2 keys={formatKeybindParts(props.item.keybind ?? "", props.language.t)} variant="neutral" />
          </Show>
          <Show when={props.active && !props.item.keybind}>
            <KeybindV2 keys={["↵"]} variant="neutral" />
          </Show>
        </Match>
        <Match when={props.item.type === "session"}>
          <div class="command-palette-v2-row-main">
            <div class="relative shrink-0">
              <Show when={props.sessionOpen}>
                <span
                  aria-hidden="true"
                  class="pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-[2px] bg-v2-background-bg-layer-04"
                  style={{ right: "calc(100% + 4px)" }}
                />
              </Show>
              <Show when={session()}>
                {(session) => (
                  <SessionTabAvatar
                    project={props.item.project}
                    directory={session().directory}
                    sessionId={session().sessionID}
                    server={session().server}
                  />
                )}
              </Show>
            </div>
            <div class="command-palette-v2-row-text">
              <span class="command-palette-v2-title" classList={{ "opacity-70": !!props.item.archived }}>
                <Lit text={props.item.title} query={props.query} />
              </span>
              <Show when={props.item.description}>
                <span class="command-palette-v2-description" classList={{ "opacity-70": !!props.item.archived }}>
                  {props.item.description}
                </span>
              </Show>
            </div>
          </div>
          <Show when={props.item.updated}>
            <span class="command-palette-v2-meta">
              {getRelativeTime(new Date(props.item.updated!).toISOString(), props.language.t)}
            </span>
          </Show>
        </Match>
      </Switch>
    </button>
  )
}
