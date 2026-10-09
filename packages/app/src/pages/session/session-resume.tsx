import type { AssistantMessage, TextPart, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import "./session-resume.css"

const ERROR_PREVIEW = 140
const ANNOUNCE_TAIL = 160

/**
 * Offers the next step when the agent is idle but the work is not done, so a
 * click replaces typing "continue" or "sim":
 * - it stopped in the middle (the person pressed stop, the provider failed, the
 *   app was closed), with the reason shown;
 * - it ended on a question ("Quer que eu…?"), with quick answers;
 * - it announced its next step and stopped, or left items of its list undone.
 */
export function SessionResume(props: { sessionID: string | undefined; busy: boolean }) {
  const sync = useSync()
  const serverSync = useServerSync()
  const sdk = useSDK()
  const language = useLanguage()
  const [dismissed, setDismissed] = createSignal<string>()
  const [sending, setSending] = createSignal(false)

  const messages = createMemo(() => sync().data.message[props.sessionID ?? ""] ?? [])

  const closingText = (messageID: string) =>
    (sync().data.part[messageID] ?? [])
      .filter((part): part is TextPart => part.type === "text" && !part.synthetic)
      .map((part) => part.text)
      .join("\n")
      .trim()
      // Markdown emphasis and emoji around the last word should not hide a question mark.
      .replace(/[\s*_`~)\]\p{Extended_Pictographic}️]+$/u, "")

  const reply = createMemo(() => {
    if (props.busy) return undefined
    const last = messages().at(-1)
    if (!last || last.role !== "assistant" || last.id === dismissed()) return undefined
    return last as AssistantMessage
  })

  const offer = createMemo(() => {
    const last = reply()
    if (!last) return undefined
    if (last.error?.name === "MessageAbortedError") return { kind: "user" as const }
    if (last.error) return { kind: "error" as const, error: errorText(last.error) }
    // A reply whose last word was a tool call was meant to go on after it.
    if (!last.time.completed || last.finish === "tool-calls") return { kind: "cut" as const }
    const text = closingText(last.id)
    if (/\?$/.test(text)) return { kind: "question" as const }
    const todos = serverSync().session.data.todo[props.sessionID ?? ""] ?? []
    const left = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length
    if (left > 0) return { kind: "todos" as const, left, total: todos.length }
    if (announcesNext(text)) return { kind: "announce" as const }
    return undefined
  })

  const lastPage = createMemo(() => {
    const replies = messages().filter((message) => message.role === "assistant")
    for (const item of [...replies].reverse()) {
      const parts = (sync().data.part[item.id] ?? []).filter(
        (part): part is ToolPart => part.type === "tool" && part.tool.startsWith("browser_"),
      )
      for (const part of [...parts].reverse()) {
        const url = part.state.status === "completed" ? part.state.metadata?.url : undefined
        if (typeof url === "string" && /^https?:\/\//.test(url)) return url
      }
    }
    return undefined
  })

  const where = () => (lastPage() ? language.t("session.resume.where", { page: host(lastPage()!) }) : "")

  const send = async (text: string) => {
    const last = reply()
    const user = [...messages()].reverse().find((message): message is UserMessage => message.role === "user")
    if (!last || !props.sessionID || !user) return
    setSending(true)
    await sdk()
      .api.session.prompt({
        sessionID: props.sessionID,
        text,
        agent: user.agent,
        model: { providerID: user.model.providerID, modelID: user.model.modelID },
        variant: user.model.variant,
      })
      .catch(() => {})
      .finally(() => setSending(false))
    setDismissed(last.id)
  }

  const resume = () => {
    const page = lastPage()
    void send(
      page
        ? language.t("session.resume.prompt", { where: language.t("session.resume.promptWhere", { url: page }) })
        : language.t("session.resume.promptPlain"),
    )
  }

  const message = () => {
    const value = offer()
    if (!value) return ""
    if (value.kind === "user") return language.t("session.resume.user", { where: where() })
    if (value.kind === "error") return language.t("session.resume.error", { where: where(), error: value.error })
    if (value.kind === "question") return language.t("session.resume.question")
    if (value.kind === "todos") return language.t("session.resume.todos", { left: value.left, total: value.total })
    if (value.kind === "announce") return language.t("session.resume.announce")
    return language.t("session.resume.message", { where: where() })
  }

  return (
    <Show when={offer()}>
      {(value) => (
        <div class="session-resume" role="status" data-kind={value().kind}>
          <span class="session-resume-text">{message()}</span>
          <Switch>
            <Match when={value().kind === "question"}>
              <For
                each={[
                  { label: "session.resume.yes", text: "session.resume.yesText" },
                  { label: "session.resume.yesAll", text: "session.resume.yesAllText" },
                ] as const}
              >
                {(answer) => (
                  <button
                    type="button"
                    class="session-resume-go"
                    disabled={sending()}
                    onClick={() => void send(language.t(answer.text))}
                  >
                    {language.t(answer.label)}
                  </button>
                )}
              </For>
            </Match>
            <Match when={true}>
              <button type="button" class="session-resume-go" disabled={sending()} onClick={resume}>
                {language.t(value().kind === "error" ? "session.resume.retry" : "session.resume.action")}
              </button>
            </Match>
          </Switch>
          <button
            type="button"
            class="session-resume-close"
            aria-label={language.t("common.close")}
            onClick={() => setDismissed(reply()?.id)}
          >
            ×
          </button>
        </div>
      )}
    </Show>
  )
}

function host(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function errorText(error: NonNullable<AssistantMessage["error"]>) {
  const data = "data" in error ? (error.data as { message?: unknown }) : undefined
  const text = typeof data?.message === "string" ? data.message : error.name
  return text.length > ERROR_PREVIEW ? `${text.slice(0, ERROR_PREVIEW)}…` : text
}

/** Ends on a colon or ellipsis, or says what it will do next, without having done it. */
function announcesNext(text: string) {
  if (/(:|\.\.\.|…)$/.test(text)) return true
  return /\b(agora vou|vou continuar|em seguida,? vou|vou seguir|let me|i'll now|next,? i'll)\b/i.test(
    text.slice(-ANNOUNCE_TAIL),
  )
}
