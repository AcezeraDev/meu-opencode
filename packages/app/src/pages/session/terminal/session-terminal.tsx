import type {
  AssistantMessage,
  Message,
  Part,
  PermissionRequest,
  ReasoningPart,
  TextPart,
  Todo,
  ToolPart,
} from "@opencode-ai/sdk/v2"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { createEffect, createMemo, createResource, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServerJson } from "@/utils/server-json"
import "./session-terminal.css"

/** Older messages stay one click away, so a long lesson session does not draw thousands of lines. */
const PAGE = 60
const OUT_LIMIT = 140
const BRIEF_THOUGHT_MS = 3000
const DETAIL_LIMIT = 4000
/** How close to the bottom counts as following the conversation as it grows. */
const FOLLOW_SLACK = 120

type Permission = {
  request: PermissionRequest | undefined
  responding: boolean
  decide: (response: "once" | "always" | "reject") => void
}

/**
 * Terminal mode: the conversation as a transcript of compact lines. Every
 * action is one line (`⏺ Clicar("Finalizar")` with its outcome under it) that
 * opens in place; reasoning folds into "✻ Pensou por 31 s"; the todo list sits
 * where the agent wrote it; a permission request is asked right in the
 * transcript with numbered answers. Beside it, the selected step in full: the
 * page as it was, what went in and what came out, and the whole run as a log.
 */
export function SessionTerminal(props: {
  sessionID: string
  permission?: Permission
  /** Older messages still on the server, fetched on request. */
  history?: { more: () => boolean; loading: () => boolean; load: () => void }
}) {
  const sync = useSync()
  const language = useLanguage()
  const [shown, setShown] = createSignal(PAGE)
  const [open, setOpen] = createSignal<Record<string, boolean>>({})
  const [picked, setPicked] = createSignal<string>()
  const [tab, setTab] = createSignal<"step" | "log">("step")
  let scroller: HTMLDivElement | undefined

  const messages = createMemo(() => sync().data.message[props.sessionID] ?? [])
  const visible = createMemo(() => messages().slice(-shown()))
  const hidden = createMemo(() => Math.max(0, messages().length - shown()))
  const parts = (messageID: string) => sync().data.part[messageID] ?? []

  const tools = createMemo(() =>
    messages()
      .filter((message) => message.role === "assistant")
      .flatMap((message) => parts(message.id).filter((part): part is ToolPart => part.type === "tool")),
  )
  // Follows the live step until a step is picked by hand.
  const selected = createMemo(() => {
    const list = tools()
    return (
      list.find((part) => part.id === picked()) ??
      [...list].reverse().find((part) => part.state.status === "running") ??
      list.at(-1)
    )
  })

  const toggle = (id: string) => setOpen((value) => ({ ...value, [id]: !value[id] }))
  const pick = (part: ToolPart) => {
    setPicked(part.id)
    setTab("step")
  }
  const step = (delta: number) => {
    const list = tools()
    const index = list.findIndex((part) => part.id === selected()?.id)
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))]
    if (next) pick(next)
  }

  // Stays at the bottom while the transcript grows, unless the person scrolled up to read.
  createEffect(
    on(
      () => [tools().length, messages().length, props.permission?.request?.id],
      () => {
        const el = scroller
        if (!el) return
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK
        if (near) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight }))
      },
    ),
  )

  return (
    <div class="session-terminal">
      <div
        class="session-terminal-transcript"
        ref={(el) => {
          scroller = el
          requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight }))
        }}
      >
        <div class="session-terminal-column">
          <Show when={hidden() > 0}>
            <button type="button" class="session-terminal-more" onClick={() => setShown((value) => value + PAGE)}>
              {language.t("session.terminal.earlier", { count: hidden() })}
            </button>
          </Show>
          <Show when={hidden() === 0 && props.history?.more()}>
            <button
              type="button"
              class="session-terminal-more"
              disabled={props.history!.loading()}
              onClick={() => {
                setShown((value) => value + PAGE)
                props.history!.load()
              }}
            >
              {language.t(props.history!.loading() ? "session.terminal.loadingOlder" : "session.terminal.older")}
            </button>
          </Show>
          <For each={visible()}>
            {(message) => (
              <Switch>
                <Match when={message.role === "user"}>
                  <UserLine message={message} parts={parts(message.id)} />
                </Match>
                <Match when={message.role === "assistant"}>
                  <AssistantLines
                    message={message as AssistantMessage}
                    parts={parts(message.id)}
                    open={open()}
                    selected={selected()?.id}
                    onToggle={toggle}
                    onPick={pick}
                  />
                </Match>
              </Switch>
            )}
          </For>
          <Show when={props.permission?.request} keyed>
            {(request) => (
              <PermissionAsk
                request={request}
                responding={props.permission!.responding}
                onDecide={props.permission!.decide}
              />
            )}
          </Show>
        </div>
      </div>

      <aside class="session-terminal-detail" aria-label={language.t("session.terminal.detail")}>
        <div class="session-terminal-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab() === "step"} onClick={() => setTab("step")}>
            {language.t("session.terminal.tab.step")}
          </button>
          <button type="button" role="tab" aria-selected={tab() === "log"} onClick={() => setTab("log")}>
            {language.t("session.terminal.tab.log", { count: tools().length })}
          </button>
        </div>
        <Show when={tab() === "step"}>
          <Show
            when={selected()}
            keyed
            fallback={<p class="session-terminal-empty">{language.t("session.terminal.noSteps")}</p>}
          >
            {(part) => (
              <StepDetail
                sessionID={props.sessionID}
                part={part}
                position={language.t("session.terminal.position", {
                  index: tools().findIndex((item) => item.id === part.id) + 1,
                  total: tools().length,
                })}
                onPrev={() => step(-1)}
                onNext={() => step(1)}
              />
            )}
          </Show>
        </Show>
        <Show when={tab() === "log"}>
          <ol class="session-terminal-log">
            <For each={tools()}>
              {(part) => (
                <li>
                  <button type="button" data-active={selected()?.id === part.id ? "" : undefined} onClick={() => pick(part)}>
                    <span class="session-terminal-log-time">{clock(part)}</span>
                    <span>
                      {toolName(part, language.t)}({toolArg(part)}) → {toolOut(part, language.t)}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </aside>
    </div>
  )
}

function UserLine(props: { message: Message; parts: Part[] }) {
  const language = useLanguage()
  const text = () =>
    props.parts
      .filter((part): part is TextPart => part.type === "text" && !part.synthetic)
      .map((part) => part.text)
      .join("\n")
      .trim()
  const files = () => props.parts.filter((part) => part.type === "file").length
  return (
    <div class="session-terminal-user">
      <span class="session-terminal-caret" aria-hidden="true">
        &gt;
      </span>
      <span class="session-terminal-user-text">{text()}</span>
      <Show when={files() > 0}>
        <span class="session-terminal-files">{language.t("session.terminal.files", { count: files() })}</span>
      </Show>
    </div>
  )
}

function AssistantLines(props: {
  message: AssistantMessage
  parts: Part[]
  open: Record<string, boolean>
  selected: string | undefined
  onToggle: (id: string) => void
  onPick: (part: ToolPart) => void
}) {
  const language = useLanguage()
  return (
    <>
      <For each={props.parts}>
        {(part) => (
          <Switch>
            <Match when={part.type === "text" && !(part as TextPart).synthetic && (part as TextPart).text.trim()}>
              <div class="session-terminal-say">
                <span class="session-terminal-bullet" aria-hidden="true">
                  ●
                </span>
                <Markdown
                  class="session-terminal-markdown"
                  text={(part as TextPart).text}
                  cacheKey={part.id}
                  streaming={!props.message.time.completed}
                />
              </div>
            </Match>
            <Match when={part.type === "reasoning" && (part as ReasoningPart).text.trim() && !brief(part as ReasoningPart)}>
              <div class="session-terminal-think">
                <button type="button" aria-expanded={!!props.open[part.id]} onClick={() => props.onToggle(part.id)}>
                  <span aria-hidden="true">✻</span>
                  {language.t("session.terminal.thought", { time: thinkTime(part as ReasoningPart) })}
                  <span class="session-terminal-hint">
                    {language.t(props.open[part.id] ? "session.terminal.hide" : "session.terminal.showThought")}
                  </span>
                </button>
                <Show when={props.open[part.id]}>
                  <p>{(part as ReasoningPart).text}</p>
                </Show>
              </div>
            </Match>
            <Match when={part.type === "tool" && (part as ToolPart).tool === "todowrite"}>
              <TodoBlock part={part as ToolPart} />
            </Match>
            <Match when={part.type === "tool"}>
              <ToolLine
                part={part as ToolPart}
                open={!!props.open[part.id]}
                selected={props.selected === part.id}
                onToggle={() => props.onToggle(part.id)}
                onPick={() => props.onPick(part as ToolPart)}
              />
            </Match>
          </Switch>
        )}
      </For>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <div class="session-terminal-error">✗ {errorText(props.message)}</div>
      </Show>
      <Show when={props.message.error?.name === "MessageAbortedError"}>
        <div class="session-terminal-stopped">■ {language.t("session.terminal.stopped")}</div>
      </Show>
    </>
  )
}

function ToolLine(props: {
  part: ToolPart
  open: boolean
  selected: boolean
  onToggle: () => void
  onPick: () => void
}) {
  const language = useLanguage()
  const status = () => props.part.state.status
  return (
    <div class="session-terminal-tool" data-status={status()}>
      <button
        type="button"
        class="session-terminal-tool-row"
        data-selected={props.selected ? "" : undefined}
        aria-expanded={props.open}
        onClick={() => {
          props.onToggle()
          props.onPick()
        }}
      >
        <span class="session-terminal-call">
          <span class="session-terminal-dot" aria-hidden="true">
            ⏺
          </span>
          <span class="session-terminal-name">{toolName(props.part, language.t)}</span>(
          <span class="session-terminal-arg">{toolArg(props.part)}</span>)
          <Show when={duration(props.part)}>
            <span class="session-terminal-ms">{duration(props.part)}</span>
          </Show>
        </span>
        <span class="session-terminal-out">⎿ {toolOut(props.part, language.t)}</span>
      </button>
      <Show when={props.open}>
        <pre class="session-terminal-io">{clip(output(props.part) || inputText(props.part), DETAIL_LIMIT)}</pre>
      </Show>
    </div>
  )
}

function TodoBlock(props: { part: ToolPart }) {
  const todos = () => (Array.isArray(props.part.state.input?.todos) ? (props.part.state.input.todos as Todo[]) : [])
  return (
    <Show when={todos().length > 0}>
      <ul class="session-terminal-todo">
        <For each={todos()}>
          {(todo) => (
            <li data-status={todo.status}>
              <span aria-hidden="true">
                {todo.status === "completed" ? "☒" : todo.status === "in_progress" ? "▸" : todo.status === "cancelled" ? "–" : "☐"}
              </span>
              {todo.content}
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

/** A permission asked in the transcript, answered with a click or with 1, 2 or 3. */
function PermissionAsk(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const options = [
    { key: "1", response: "once", label: "session.terminal.permission.once" },
    { key: "2", response: "always", label: "session.terminal.permission.always" },
    { key: "3", response: "reject", label: "session.terminal.permission.reject" },
  ] as const
  const what = () => {
    const metadata = props.request.metadata ?? {}
    const action = typeof metadata["action"] === "string" ? metadata["action"] : undefined
    return [props.request.permission, action, ...props.request.patterns].filter(Boolean).join(" · ")
  }
  return (
    <div
      class="session-terminal-permission"
      role="group"
      tabIndex={-1}
      aria-label={language.t("notification.permission.title")}
      ref={(el) => requestAnimationFrame(() => el.focus({ preventScroll: true }))}
      onKeyDown={(event) => {
        const option = options.find((item) => item.key === event.key)
        if (!option || props.responding) return
        event.preventDefault()
        props.onDecide(option.response)
      }}
    >
      <span class="session-terminal-permission-title">{language.t("session.terminal.permission.title")}</span>
      <code>{what()}</code>
      <Show when={typeof props.request.metadata?.["reason"] === "string" && props.request.metadata["reason"]}>
        {(reason) => <span class="session-terminal-permission-reason">{String(reason())}</span>}
      </Show>
      <For each={options}>
        {(option) => (
          <button type="button" disabled={props.responding} onClick={() => props.onDecide(option.response)}>
            <span class="session-terminal-key">{option.key}</span>
            {language.t(option.label)}
          </button>
        )}
      </For>
    </div>
  )
}

function StepDetail(props: {
  sessionID: string
  part: ToolPart
  position: string
  onPrev: () => void
  onNext: () => void
}) {
  const language = useLanguage()
  const json = useServerJson()
  const sdk = useSDK()
  const shot = () => {
    const metadata = meta(props.part)
    return typeof metadata["shot"] === "string" ? metadata["shot"] : undefined
  }
  // The picture the browser kept after the step, when it was a browser step.
  const [picture] = createResource(
    () => (shot() ? [props.sessionID, shot()!] as const : undefined),
    ([sessionID, callID]) =>
      json<{ image?: string }>(
        `/experimental/browser/trail/${encodeURIComponent(sessionID)}/${encodeURIComponent(callID)}`,
        { directory: sdk().directory },
      ).then((body) => body?.image),
    { initialValue: undefined },
  )
  const url = () => {
    const value = meta(props.part)["url"]
    return typeof value === "string" ? value : undefined
  }
  return (
    <div class="session-terminal-step">
      <div class="session-terminal-step-head">
        <span class="session-terminal-name">{toolName(props.part, language.t)}</span>(
        <span class="session-terminal-arg">{toolArg(props.part)}</span>)
      </div>
      <Show when={url()}>
        <div class="session-terminal-url">{url()}</div>
      </Show>
      <Show when={picture.latest}>
        <img class="session-terminal-shot" src={picture.latest} alt={language.t("session.terminal.shot")} />
      </Show>
      <dl class="session-terminal-kv">
        <dt>{language.t("session.terminal.result")}</dt>
        <dd>{toolOut(props.part, language.t)}</dd>
        <dt>{language.t("session.terminal.time")}</dt>
        <dd>{duration(props.part) || "—"}</dd>
      </dl>
      <span class="session-terminal-label">{language.t("session.trail.input")}</span>
      <pre class="session-terminal-io">{clip(inputText(props.part), DETAIL_LIMIT)}</pre>
      <Show when={output(props.part)}>
        <span class="session-terminal-label">{language.t("session.trail.output")}</span>
        <pre class="session-terminal-io">{clip(output(props.part), DETAIL_LIMIT)}</pre>
      </Show>
      <div class="session-terminal-nav">
        <button type="button" onClick={props.onPrev}>
          ← {language.t("session.terminal.prev")}
        </button>
        <button type="button" onClick={props.onNext}>
          {language.t("session.terminal.next")} →
        </button>
        <span>{props.position}</span>
      </div>
    </div>
  )
}

type Translate = ReturnType<typeof useLanguage>["t"]

const NAMES: Record<string, string> = {
  browser_navigate: "session.terminal.tool.navigate",
  browser_snapshot: "session.terminal.tool.read",
  browser_screenshot: "session.terminal.tool.screenshot",
  browser_find: "session.terminal.tool.find",
  browser_batch: "session.terminal.tool.batch",
  browser_script: "session.terminal.tool.script",
  browser_inspect: "session.terminal.tool.inspect",
  read: "session.terminal.tool.readFile",
  edit: "session.terminal.tool.edit",
  write: "session.terminal.tool.write",
  apply_patch: "session.terminal.tool.edit",
  bash: "session.terminal.tool.run",
  shell: "session.terminal.tool.run",
  grep: "session.terminal.tool.search",
  glob: "session.terminal.tool.files",
  webfetch: "session.terminal.tool.fetch",
  websearch: "session.terminal.tool.websearch",
  task: "session.terminal.tool.task",
  skill: "session.terminal.tool.skill",
  write_text: "session.terminal.tool.writer",
  question: "session.terminal.tool.question",
}

const ACTIONS: Record<string, string> = {
  click: "session.terminal.act.click",
  double_click: "session.terminal.act.click",
  fill: "session.terminal.act.fill",
  type: "session.terminal.act.type",
  press: "session.terminal.act.press",
  scroll: "session.terminal.act.scroll",
  select: "session.terminal.act.select",
  check: "session.terminal.act.check",
  uncheck: "session.terminal.act.check",
  hover: "session.terminal.act.hover",
  upload_file: "session.terminal.act.upload",
  wait_for: "session.terminal.act.wait",
}

const OUTCOMES: Record<string, string> = {
  navigation: "session.terminal.outcome.navigation",
  success_confirmed: "session.terminal.outcome.confirmed",
  target_changed: "session.terminal.outcome.changed",
  success_no_visible_change: "session.terminal.outcome.nothing",
  uncertain: "session.terminal.outcome.uncertain",
}

function toolName(part: ToolPart, t: Translate) {
  const input = part.state.input ?? {}
  if (part.tool === "browser_act" && typeof input["action"] === "string" && ACTIONS[input["action"]])
    return t(ACTIONS[input["action"]] as Parameters<Translate>[0])
  const key = NAMES[part.tool]
  return key ? t(key as Parameters<Translate>[0]) : part.tool
}

function toolArg(part: ToolPart) {
  const input = part.state.input ?? {}
  const target = meta(part)["target"]
  const value =
    (typeof target === "string" && target ? `“${target}”` : undefined) ??
    [input["url"], input["command"], input["filePath"], input["pattern"], input["query"], input["name"], input["text"], input["ref"], input["description"]].find(
      (item): item is string => typeof item === "string" && item.length > 0,
    ) ??
    (Array.isArray(input["steps"]) ? String(input["steps"].length) : "")
  return clip(value.replace(/\s+/g, " "), 80)
}

function toolOut(part: ToolPart, t: Translate) {
  const state = part.state
  if (state.status === "pending" || state.status === "running") return t("session.terminal.running")
  if (state.status === "error") return clip(firstLine(state.error), OUT_LIMIT)
  const outcome = meta(part)["outcome"]
  if (typeof outcome === "string" && OUTCOMES[outcome]) {
    const url = meta(part)["url"]
    const where = typeof url === "string" && outcome === "navigation" ? ` · ${shortUrl(url)}` : ""
    return t(OUTCOMES[outcome] as Parameters<Translate>[0]) + where
  }
  return clip(firstLine(state.output) || state.title || "✓", OUT_LIMIT)
}

function meta(part: ToolPart): Record<string, unknown> {
  const state = part.state as { metadata?: Record<string, unknown> }
  return state.metadata ?? {}
}

function output(part: ToolPart) {
  if (part.state.status === "completed") return part.state.output
  if (part.state.status === "error") return part.state.error
  return ""
}

function inputText(part: ToolPart) {
  return JSON.stringify(part.state.input ?? {}, null, 2)
}

function duration(part: ToolPart) {
  if (part.state.status !== "completed" && part.state.status !== "error") return ""
  const seconds = (part.state.time.end - part.state.time.start) / 1000
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(1).replace(".", ",")} s`
}

function clock(part: ToolPart) {
  const state = part.state as { time?: { start?: number } }
  const start = state.time?.start
  if (!start) return "--:--:--"
  const date = new Date(start)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, "0")).join(":")
}

function thinkTime(part: ReasoningPart) {
  const end = part.time.end
  if (!end) return "…"
  const seconds = Math.max(1, Math.round((end - part.time.start) / 1000))
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`
}

/** A finished thought this short is noise between two actions; the line is left out. */
function brief(part: ReasoningPart) {
  return !!part.time.end && part.time.end - part.time.start < BRIEF_THOUGHT_MS
}

function errorText(message: AssistantMessage) {
  const error = message.error
  if (!error) return ""
  const data = "data" in error ? (error.data as { message?: unknown }) : undefined
  return clip(typeof data?.message === "string" ? data.message : error.name, OUT_LIMIT * 2)
}

function firstLine(text: string | undefined) {
  return (text ?? "").split("\n").find((line) => line.trim())?.trim() ?? ""
}

function shortUrl(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.host + parsed.pathname
  } catch {
    return url
  }
}

function clip(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
