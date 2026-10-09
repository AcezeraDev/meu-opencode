/**
 * What the browser extension asks of the app: a request typed in its side panel
 * or picked from a page's menu, its Stop button, and its answer to a
 * permission. The server relays them as global events (browser/bridge.ts); the
 * app acts on them because it is the one that knows the project, model and
 * agent a new conversation should use.
 */

type ServerEvent = { name: string; details?: { type: string; properties?: unknown } }
type Tab = { targetId?: string; url?: string; title?: string }
type Session = { sessionID: string; directory: string }

export function listenExtension(input: {
  listen: (cb: (event: ServerEvent) => void) => () => void
  /** Starts a conversation that sends `text` right away, as the quick-ask box does. */
  start: (text: string) => void
  /** Sends `text` in the conversation on screen; false when none is open. */
  follow: (text: string) => boolean
  abort: (session: Session) => Promise<unknown>
  reply: (input: Session & { requestID: string; reply: "once" | "always" | "reject" }) => Promise<unknown>
  /** Shows one conversation, from the side panel's "Abrir no app". */
  open: (session: Session) => void
}) {
  return input.listen((event) => {
    const type = event.details?.type
    const props = (event.details?.properties ?? {}) as Record<string, unknown>
    if (type === "lynx.extension.ask" && typeof props.text === "string") {
      const text = prompt(props.text, props.tab as Tab | undefined, props.selection as string | undefined)
      if (props.follow === true && input.follow(text)) return
      return input.start(text)
    }
    if (type === "lynx.extension.open" && typeof props.sessionID === "string") {
      return input.open({ sessionID: props.sessionID, directory: String(props.directory ?? "") })
    }
    if (type === "lynx.extension.stop" && Array.isArray(props.sessions)) {
      for (const session of props.sessions as Session[]) void input.abort(session).catch(() => undefined)
      return
    }
    if (type === "lynx.extension.answer" && typeof props.id === "string" && typeof props.reply === "string") {
      void input
        .reply({
          sessionID: String(props.sessionID),
          directory: String(props.directory),
          requestID: props.id,
          reply: props.reply as "once" | "always" | "reject",
        })
        .catch(() => undefined)
    }
  })
}

/** The request with the page it was made on, so the agent works in that tab instead of opening another. */
function prompt(text: string, tab?: Tab, selection?: string) {
  const parts = [text]
  if (selection?.trim()) parts.push(`Trecho selecionado na página:\n"""\n${selection.trim().slice(0, 4000)}\n"""`)
  if (tab?.url)
    parts.push(
      `(Pedido feito pela extensão no Brave, na aba "${tab.title ?? ""}" — ${tab.url}${tab.targetId ? `, id da aba ${tab.targetId}` : ""}. Se precisar do navegador, use essa aba.)`,
    )
  return parts.join("\n\n")
}
