import type { AssistantMessage, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import "./session-resume.css"

/**
 * Offers to pick a task up again when the agent stopped in the middle of it:
 * the app was closed, the provider failed, the browser dropped out, or the
 * person pressed stop. One click sends it on with the same agent and model,
 * told which page it was last on and to look before acting again.
 */
export function SessionResume(props: { sessionID: string | undefined; busy: boolean }) {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()
  const [dismissed, setDismissed] = createSignal<string>()
  const [sending, setSending] = createSignal(false)

  const messages = createMemo(() => sync().data.message[props.sessionID ?? ""] ?? [])

  /** The last reply, when it did not come to an end of its own. */
  const stopped = createMemo(() => {
    if (props.busy) return undefined
    const last = messages().at(-1)
    if (!last || last.role !== "assistant") return undefined
    const reply = last as AssistantMessage
    if (reply.id === dismissed()) return undefined
    if (reply.error) return reply
    if (!reply.time.completed) return reply
    // A reply whose last word was a tool call was meant to go on after it.
    if (reply.finish === "tool-calls") return reply
    return undefined
  })

  const lastPage = createMemo(() => {
    const replies = messages().filter((message) => message.role === "assistant")
    for (const reply of [...replies].reverse()) {
      const parts = (sync().data.part[reply.id] ?? []).filter(
        (part): part is ToolPart => part.type === "tool" && part.tool.startsWith("browser_"),
      )
      for (const part of [...parts].reverse()) {
        const url = part.state.status === "completed" ? part.state.metadata?.url : undefined
        if (typeof url === "string" && /^https?:\/\//.test(url)) return url
      }
    }
    return undefined
  })

  const host = (url: string) => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }

  const resume = async () => {
    const reply = stopped()
    const user = [...messages()].reverse().find((message): message is UserMessage => message.role === "user")
    if (!reply || !props.sessionID || !user) return
    setSending(true)
    const page = lastPage()
    await sdk()
      .api.session.prompt({
        sessionID: props.sessionID,
        text: language.t("session.resume.prompt", {
          where: page ? language.t("session.resume.promptWhere", { url: page }) : "",
        }),
        agent: user.agent,
        model: { providerID: user.model.providerID, modelID: user.model.modelID },
        variant: user.model.variant,
      })
      .catch(() => {})
      .finally(() => setSending(false))
    setDismissed(reply.id)
  }

  return (
    <Show when={stopped()}>
      {(reply) => (
        <div class="session-resume" role="status">
          <span class="session-resume-text">
            {language.t("session.resume.message", {
              where: lastPage() ? language.t("session.resume.where", { page: host(lastPage()!) }) : "",
            })}
          </span>
          <button type="button" class="session-resume-go" disabled={sending()} onClick={() => void resume()}>
            {language.t("session.resume.action")}
          </button>
          <button
            type="button"
            class="session-resume-close"
            aria-label={language.t("common.close")}
            onClick={() => setDismissed(reply().id)}
          >
            ×
          </button>
        </div>
      )}
    </Show>
  )
}
