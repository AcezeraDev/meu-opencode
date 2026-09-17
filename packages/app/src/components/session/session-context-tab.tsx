import { createMemo, createEffect, createSignal, on, onCleanup, For, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { checksum } from "@opencode-ai/core/util/encode"
import { findLast } from "@opencode-ai/core/util/array"
import { same } from "@/utils/same"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { File } from "@opencode-ai/session-ui/file"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getRelativeTime } from "@/utils/time"
import { downloadSessionExport, fetchSessionExport, sessionExportFilename } from "@/utils/session-export"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getSessionContext } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import { createSessionContextFormatter } from "./session-context-format"
import "./session-context-tab.css"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

/** Turns kept in the per-turn chart; older ones would shrink bars below legibility. */
const GROWTH_TURNS = 48

const tokenTotal = (message: AssistantMessage) =>
  message.tokens.input +
  message.tokens.output +
  message.tokens.reasoning +
  message.tokens.cache.read +
  message.tokens.cache.write

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

/** Eases toward the latest value, so a new turn visibly adds to what was already there. */
function createTween(target: () => number, duration = 640) {
  const [value, setValue] = createSignal(0)
  let frame: number | undefined
  createEffect(
    on(target, (next) => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (prefersReducedMotion()) {
        setValue(next)
        return
      }
      const from = value()
      const start = performance.now()
      const step = (now: number) => {
        const progress = Math.min(1, (now - start) / duration)
        setValue(from + (next - from) * (progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress)))
        frame = progress < 1 ? requestAnimationFrame(step) : undefined
      }
      frame = requestAnimationFrame(step)
    }),
  )
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  return value
}

/** Re-runs the CSS flash on an element whenever its value changes after the first render. */
function flashOnChange(element: () => HTMLElement | undefined, value: () => unknown) {
  createEffect(
    on(
      value,
      () => {
        const el = element()
        if (!el) return
        el.removeAttribute("data-flash")
        void el.offsetWidth
        el.setAttribute("data-flash", "")
      },
      { defer: true },
    ),
  )
}

function LedgerRow(props: {
  label: string
  value: number | undefined
  total: number
  format: (value: number | undefined) => string
  strong?: boolean
}) {
  const [value, setValue] = createSignal<HTMLElement>()
  flashOnChange(value, () => props.value)
  const share = () => (props.total > 0 && props.value ? Math.min(1, props.value / props.total) : 0)

  return (
    <div class="session-context-row" data-strong={props.strong ? "" : undefined}>
      <dt>{props.label}</dt>
      <dd ref={setValue}>{props.format(props.value)}</dd>
      <Show when={!props.strong}>
        <span class="session-context-row-share" style={{ "--share": share() }} aria-hidden="true" />
      </Show>
    </div>
  )
}

function RawMessageContent(props: { message: Message; getParts: (id: string) => Part[]; onRendered: () => void }) {
  const file = createMemo(() => {
    const parts = props.getParts(props.message.id)
    const contents = JSON.stringify({ message: props.message, parts }, null, 2)
    return {
      name: `${props.message.role}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: Message
  role: string
  getParts: (id: string) => Part[]
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id} class="session-context-message" data-role={props.message.role}>
      <StickyAccordionHeader>
        <Accordion.Trigger class="session-context-message-trigger">
          <span class="session-context-message-role">
            <span class="session-context-message-dot" aria-hidden="true" />
            {props.role}
          </span>
          <span class="session-context-message-id">{props.message.id}</span>
          <span class="session-context-message-time">{props.time(props.message.time.created)}</span>
          <Icon name="chevron-down" size="small" class="session-context-message-chevron" />
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="session-context-message-content">
        <div class="session-context-message-body">
          <RawMessageContent message={props.message} getParts={props.getParts} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: Message[] = []
const emptyUserMessages: UserMessage[] = []

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      const boundary = userMessages().findIndex((message) => message.id === revert)
      return boundary < 0 ? userMessages() : userMessages().slice(0, boundary)
    },
    emptyUserMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const ctx = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const compact = createMemo(
    () => new Intl.NumberFormat(language.intl(), { notation: "compact", maximumFractionDigits: 1 }),
  )

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = findLast(visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  // The model is known as soon as it answers, even before a reply reports token usage.
  const model = createMemo(() => {
    const c = ctx()
    if (c) return { model: c.modelLabel, provider: c.providerLabel }
    const last = findLast(messages(), (m): m is AssistantMessage => m.role === "assistant")
    if (!last) return
    const provider = providers.all().get(last.providerID)
    return {
      model: provider?.models[last.modelID]?.name ?? last.modelID,
      provider: provider?.name ?? last.providerID,
    }
  })

  const lastActivity = createMemo(() => messages().at(-1)?.time.created ?? info()?.time.updated)

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, messages().length, systemPrompt()],
      () => {
        const c = ctx()
        if (!c?.input) return []
        return estimateSessionContextBreakdown({
          messages: messages(),
          parts: sync().data.part as Record<string, Part[] | undefined>,
          input: c.input,
          systemPrompt: systemPrompt(),
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  // Segments share the filled part of the track; without a known limit they span it all.
  const fill = createMemo(() => {
    const c = ctx()
    if (!c) return 0
    if (c.usage === null) return 1
    return Math.min(1, c.total / (c.limit ?? c.total))
  })

  const segments = createMemo(() => {
    const scale = fill() / 100
    return breakdown().reduce<{
      left: number
      items: { key: SessionContextBreakdownKey; left: number; size: number }[]
    }>(
      (acc, segment) => {
        const size = segment.width * scale
        return { left: acc.left + size, items: [...acc.items, { key: segment.key, left: acc.left, size }] }
      },
      { left: 0, items: [] },
    ).items
  })

  const level = createMemo(() => {
    const usage = ctx()?.usage
    if (usage === null || usage === undefined) return "normal"
    if (usage >= 90) return "critical"
    if (usage >= 70) return "high"
    return "normal"
  })

  const usage = createTween(() => ctx()?.usage ?? 0)
  const used = createTween(() => ctx()?.total ?? 0)

  const turns = createMemo(() =>
    messages()
      .flatMap((message) =>
        message.role === "assistant" && tokenTotal(message) > 0 ? [{ id: message.id, total: tokenTotal(message) }] : [],
      )
      .slice(-GROWTH_TURNS),
  )
  const peak = createMemo(() => Math.max(1, ...turns().map((turn) => turn.total)))
  const [hoveredTurn, setHoveredTurn] = createSignal<number>()

  const [promptExpanded, setPromptExpanded] = createSignal(false)

  const exportSession = async () => {
    const sessionID = params.id
    if (!sessionID) return
    try {
      const data = await fetchSessionExport({
        sessionID,
        client: sdk().client,
      })
      const filename = sessionExportFilename(data.info)
      downloadSessionExport(filename, data)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("toast.session.export.success.title"),
        description: language.t("toast.session.export.success.description", { filename }),
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("toast.session.export.failed.title"),
        description: err instanceof Error ? err.message : language.t("toast.session.export.failed.description"),
      })
    }
  }

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  const getParts = (id: string) => (sync().data.part[id] ?? []) as Part[]

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  const number = (value: number | undefined) => formatter().number(value)

  return (
    <ScrollView
      class="@container h-full session-context"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="session-context-body">
        <header class="session-context-head" data-reveal style={{ "--i": 0 }}>
          <h2 class="session-context-title">{info()?.title ?? params.id ?? "—"}</h2>
          <p class="session-context-meta">
            <Show when={model()} fallback={<span>{language.t("context.meta.noModel")}</span>}>
              {(current) => (
                <span class="session-context-model">
                  <span class="session-context-model-mark" aria-hidden="true" />
                  <span class="session-context-model-name">{current().model}</span>
                  <span class="session-context-model-provider">{current().provider}</span>
                </span>
              )}
            </Show>
            <Show when={lastActivity()}>
              {(time) => (
                <span class="session-context-when" title={formatter().time(info()?.time.created)}>
                  {language.t("context.meta.active", {
                    time: getRelativeTime(new Date(time()).toISOString(), language.t).toLowerCase(),
                  })}
                </span>
              )}
            </Show>
          </p>
        </header>

        <section class="session-context-meter" data-reveal data-level={level()} style={{ "--i": 1 }}>
          <div class="session-context-meter-top">
            <h3 class="session-context-heading">{language.t("context.meter.title")}</h3>
            <Show when={ctx()?.usage !== null && ctx()}>
              <span class="session-context-usage">
                {Math.round(usage()).toLocaleString(language.intl())}
                <span class="session-context-usage-unit">%</span>
              </span>
            </Show>
          </div>

          <div
            class="session-context-track"
            role="meter"
            aria-label={language.t("context.meter.title")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={ctx()?.usage ?? 0}
          >
            <For each={segments()}>
              {(segment, index) => (
                <span
                  class="session-context-segment"
                  style={{
                    "--left": segment.left,
                    "--size": segment.size,
                    "--color": BREAKDOWN_COLOR[segment.key],
                    "--i": index(),
                  }}
                />
              )}
            </For>
            <Show when={ctx()?.usage !== null}>
              <span class="session-context-tick" style={{ "--at": 0.25 }} aria-hidden="true" />
              <span class="session-context-tick" style={{ "--at": 0.5 }} aria-hidden="true" />
              <span class="session-context-tick" style={{ "--at": 0.75 }} aria-hidden="true" />
            </Show>
          </div>

          <Show when={ctx()} fallback={<p class="session-context-empty">{language.t("context.meter.empty")}</p>}>
            {(current) => (
              <>
                <div class="session-context-meter-foot">
                  <Show
                    when={current().limit}
                    fallback={
                      <span>{language.t("context.meter.unknownLimit", { used: number(Math.round(used())) })}</span>
                    }
                  >
                    {(limit) => (
                      <>
                        <span>
                          {language.t("context.meter.usage", {
                            used: number(Math.round(used())),
                            limit: number(limit()),
                          })}
                        </span>
                        <span>
                          {language.t("context.meter.free", {
                            free: compact().format(Math.max(0, limit() - current().total)),
                          })}
                        </span>
                      </>
                    )}
                  </Show>
                </div>
                <Show when={breakdown().length > 0}>
                  <ul class="session-context-legend" title={language.t("context.breakdown.note")}>
                    <For each={breakdown()}>
                      {(segment) => (
                        <li style={{ "--color": BREAKDOWN_COLOR[segment.key] }}>
                          <span class="session-context-swatch" aria-hidden="true" />
                          {breakdownLabel(segment.key)}
                          <span class="session-context-legend-value">
                            {segment.percent.toLocaleString(language.intl())}%
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </>
            )}
          </Show>
        </section>

        <Show when={ctx()}>
          {(current) => (
            <section class="session-context-ledger" data-reveal style={{ "--i": 2 }}>
              <h3 class="session-context-heading">{language.t("context.ledger.title")}</h3>
              <dl class="session-context-rows">
                <LedgerRow
                  label={language.t("context.ledger.input")}
                  value={current().message.tokens.input}
                  total={current().total}
                  format={number}
                />
                <LedgerRow
                  label={language.t("context.ledger.output")}
                  value={current().message.tokens.output}
                  total={current().total}
                  format={number}
                />
                <Show when={current().message.tokens.reasoning > 0}>
                  <LedgerRow
                    label={language.t("context.ledger.reasoning")}
                    value={current().message.tokens.reasoning}
                    total={current().total}
                    format={number}
                  />
                </Show>
                <LedgerRow
                  label={language.t("context.ledger.cacheRead")}
                  value={current().message.tokens.cache.read}
                  total={current().total}
                  format={number}
                />
                <LedgerRow
                  label={language.t("context.ledger.cacheWrite")}
                  value={current().message.tokens.cache.write}
                  total={current().total}
                  format={number}
                />
                <LedgerRow
                  label={language.t("context.ledger.total")}
                  value={current().total}
                  total={current().total}
                  format={number}
                  strong
                />
              </dl>
              <div class="session-context-cost">
                <span>{language.t("context.ledger.cost")}</span>
                <strong>{usd().format(info()?.cost ?? 0)}</strong>
              </div>
            </section>
          )}
        </Show>

        <Show when={turns().length > 1}>
          <section class="session-context-growth" data-reveal style={{ "--i": 3 }}>
            <div class="session-context-section-top">
              <h3 class="session-context-heading">{language.t("context.growth.title")}</h3>
              <span class="session-context-readout" aria-live="polite">
                <Show
                  when={hoveredTurn() !== undefined && turns()[hoveredTurn()!]}
                  fallback={language.t("context.growth.turns", { count: turns().length })}
                >
                  {(turn) =>
                    language.t("context.growth.readout", {
                      turn: hoveredTurn()! + 1,
                      tokens: number(turn().total),
                    })
                  }
                </Show>
              </span>
            </div>
            <div
              class="session-context-bars"
              role="img"
              aria-label={language.t("context.growth.ariaLabel", {
                first: number(turns()[0]?.total),
                last: number(turns().at(-1)?.total),
                count: turns().length,
              })}
              onPointerLeave={() => setHoveredTurn(undefined)}
            >
              <For each={turns()}>
                {(turn, index) => (
                  <span
                    class="session-context-bar"
                    data-active={hoveredTurn() === index() ? "" : undefined}
                    style={{ "--height": turn.total / peak(), "--i": index() }}
                    onPointerEnter={() => setHoveredTurn(index())}
                  />
                )}
              </For>
            </div>
          </section>
        </Show>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <section class="session-context-prompt" data-reveal style={{ "--i": 4 }}>
              <div class="session-context-section-top">
                <h3 class="session-context-heading">{language.t("context.systemPrompt.title")}</h3>
                <button
                  type="button"
                  class="session-context-link"
                  aria-expanded={promptExpanded()}
                  onClick={() => setPromptExpanded((value) => !value)}
                >
                  {language.t(promptExpanded() ? "context.systemPrompt.collapse" : "context.systemPrompt.expand")}
                </button>
              </div>
              <div class="session-context-prompt-body" data-expanded={promptExpanded() ? "" : undefined}>
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </section>
          )}
        </Show>

        <section class="session-context-raw" data-reveal style={{ "--i": 5 }}>
          <div class="session-context-section-top">
            <div class="session-context-raw-title">
              <h3 class="session-context-heading">{language.t("context.rawMessages.title")}</h3>
              <span class="session-context-raw-count">
                {language.t("context.raw.count", { user: counts().user, assistant: counts().assistant })}
              </span>
            </div>
            <Button size="small" variant="ghost" class="session-context-export" onClick={exportSession}>
              <Icon name="download" size="small" />
              <span>{language.t("context.export.session")}</span>
            </Button>
          </div>
          <Accordion multiple class="session-context-messages">
            <For each={messages()}>
              {(message) => (
                <RawMessage
                  message={message}
                  role={language.t(message.role === "user" ? "context.raw.user" : "context.raw.assistant")}
                  getParts={getParts}
                  onRendered={restoreScroll}
                  time={formatter().time}
                />
              )}
            </For>
          </Accordion>
        </section>
      </div>
    </ScrollView>
  )
}
