import { GlobalBus, type GlobalEvent } from "@/bus/global"

/**
 * What the Lynx is doing, told to the browser extension so it can show it
 * without the app: the icon's badge, a desktop notification when a task ends or
 * needs a yes, and the side panel's live line and last answer.
 *
 * It reads the same server events the app's tray icon reads
 * (app/src/pages/layout/agent-tray.ts), straight off the global bus, so the
 * extension stays current even with the app's window closed. It also keeps the
 * sessions and requests the extension's Stop and permission buttons act on.
 */

export type Phase = "idle" | "working" | "done" | "attention"

export interface Status {
  phase: Phase
  /** The title of the session the line is about. */
  session?: string
  /** The tool the agent is running now, as it titles it. */
  step?: string
  /** The end of the agent's latest answer, as it is written. */
  text?: string
  /** A permission or question waiting for the person. */
  ask?: { id: string; kind: "permission" | "question"; title: string }
}

export interface Session {
  sessionID: string
  directory: string
}

export interface Ask extends Session {
  id: string
  kind: "permission" | "question"
  title: string
}

/** The answer kept for the panel; the tail is what matters while it is written. */
const TEXT_KEEP = 1200
/** Text parts remembered per session while their deltas stream in. */
const PARTS_KEEP = 40

type Props = {
  sessionID?: string
  id?: string
  requestID?: string
  status?: { type?: string }
  info?: { id?: string; title?: string }
  part?: { id?: string; type?: string; sessionID?: string; text?: string; tool?: string; state?: { status?: string; title?: string } }
  partID?: string
  field?: string
  delta?: string
  permission?: string
  action?: string
  patterns?: string[]
  resources?: string[]
  questions?: { question?: string }[]
}

export class Tracker {
  private busy = new Map<string, string>()
  private asks = new Map<string, Ask>()
  private steps = new Map<string, string>()
  private titles = new Map<string, string>()
  private texts = new Map<string, string>()
  private parts = new Map<string, { sessionID: string; text: string }>()
  private finished?: Session
  /** The session the panel's answer comes from: the last one that wrote. */
  private speaking?: string
  private shown = ""
  private listeners = new Set<(status: Status) => void>()
  private off?: () => void

  start() {
    if (this.off) return
    const handler = (event: GlobalEvent) => this.receive(event)
    GlobalBus.on("event", handler)
    this.off = () => GlobalBus.off("event", handler)
  }

  stop() {
    this.off?.()
    this.off = undefined
  }

  onChange(listener: (status: Status) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The sessions working now, for the extension's Stop. */
  running(): Session[] {
    return [...this.busy.entries()].map(([sessionID, directory]) => ({ sessionID, directory }))
  }

  /** The request waiting for the person, by id, for the extension's answer buttons. */
  ask(id: string) {
    return this.asks.get(id)
  }

  current(): Status {
    const ask = [...this.asks.values()].at(-1)
    const working = [...this.busy.entries()].at(-1)
    const about = ask?.sessionID ?? working?.[0] ?? this.finished?.sessionID ?? this.speaking
    const base = {
      session: about ? this.titles.get(about) : undefined,
      text: this.speaking ? this.texts.get(this.speaking) : undefined,
    }
    if (ask) return { ...base, phase: "attention", ask: { id: ask.id, kind: ask.kind, title: ask.title } }
    if (working) return { ...base, phase: "working", step: this.steps.get(working[0]) }
    if (this.finished) return { ...base, phase: "done" }
    return { ...base, phase: "idle" }
  }

  /** The person saw the finished task (they opened the panel or the app). */
  seen() {
    if (!this.finished) return
    this.finished = undefined
    this.emit()
  }

  receive(event: GlobalEvent) {
    const payload = event.payload as { type?: string; properties?: Props } | undefined
    const type = payload?.type
    const props = payload?.properties
    if (!type || !props) return
    const directory = event.directory ?? ""

    if ((type === "session.created" || type === "session.updated") && props.info?.id && props.info.title) {
      this.titles.set(props.info.id, props.info.title)
      return
    }
    if (type === "session.status" && props.sessionID) {
      if (props.status?.type === "idle") {
        if (this.busy.delete(props.sessionID)) this.finished = { sessionID: props.sessionID, directory }
        this.steps.delete(props.sessionID)
      }
      if (props.status?.type !== "idle") {
        this.busy.set(props.sessionID, directory)
        this.finished = undefined
      }
      return this.emit()
    }
    if ((type === "permission.asked" || type === "permission.v2.asked") && props.id && props.sessionID) {
      const what = props.permission ?? props.action ?? "permissão"
      const where = (props.patterns ?? props.resources ?? []).slice(0, 2).join(", ")
      this.asks.set(props.id, {
        id: props.id,
        sessionID: props.sessionID,
        directory,
        kind: "permission",
        title: where ? `${what}: ${where}` : what,
      })
      return this.emit()
    }
    if ((type === "question.asked" || type === "question.v2.asked") && props.id && props.sessionID) {
      this.asks.set(props.id, {
        id: props.id,
        sessionID: props.sessionID,
        directory,
        kind: "question",
        title: props.questions?.[0]?.question ?? "pergunta",
      })
      return this.emit()
    }
    if (/^(permission|question)(\.v2)?\.(replied|rejected)$/.test(type)) {
      const id = props.requestID ?? props.id
      if (id && this.asks.delete(id)) this.emit()
      return
    }
    if (type === "message.part.updated" && props.part?.sessionID) {
      const part = props.part
      const sessionID = props.part.sessionID
      if (part.type === "tool" && part.state?.status === "running" && this.busy.has(sessionID)) {
        this.steps.set(sessionID, part.state.title || part.tool || "")
        return this.emit()
      }
      if (part.type === "text" && part.id && typeof part.text === "string") {
        this.write(part.id, sessionID, part.text)
        return this.emit()
      }
      return
    }
    if (type === "message.part.delta" && props.partID && props.field === "text" && props.delta) {
      const known = this.parts.get(props.partID)
      const sessionID = known?.sessionID ?? props.sessionID
      if (!sessionID) return
      this.write(props.partID, sessionID, (known?.text ?? "") + props.delta)
      return this.emit()
    }
  }

  private write(partID: string, sessionID: string, text: string) {
    this.parts.delete(partID)
    this.parts.set(partID, { sessionID, text: text.slice(-TEXT_KEEP) })
    if (this.parts.size > PARTS_KEEP) this.parts.delete(this.parts.keys().next().value!)
    this.texts.set(sessionID, text.slice(-TEXT_KEEP))
    this.speaking = sessionID
  }

  private emit() {
    const status = this.current()
    const key = JSON.stringify(status)
    if (key === this.shown) return
    this.shown = key
    for (const listener of this.listeners) listener(status)
  }
}

export * as ExtensionStatus from "./extension-status"
