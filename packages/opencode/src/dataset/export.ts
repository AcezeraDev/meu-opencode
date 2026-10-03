import fs from "fs/promises"
import os from "os"
import path from "path"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Lessons } from "@/memory/lessons"

/**
 * DatasetExporter: the turns the person rated Approved or Excellent, as chat
 * examples for fine-tuning (one JSON per line, OpenAI-style `messages` with
 * tool calls), read from the sessions OpenCode already stores. Turns rated
 * "needs work" and turns never rated stay out: nothing goes in on its own.
 *
 * Reasoning is left out (it is the provider's private scratch), secrets are
 * removed, and long tool outputs are cut so one example cannot swamp the rest.
 */

export type Rating = "excellent" | "approved" | "rejected"
const RANK: Record<Rating, number> = { rejected: 0, approved: 1, excellent: 2 }
const TOOL_OUTPUT_MAX = 6000

export function ratings(metadata: Record<string, unknown> | undefined): Record<string, Rating> {
  const value = metadata?.["ratings"]
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Rating] => entry[1] in RANK),
  )
}

export function accepted(rating: Rating, min: "approved" | "excellent") {
  return RANK[rating] >= RANK[min]
}

type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant"
      content: string
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
    }
  | { role: "tool"; tool_call_id: string; content: string }

export interface Example {
  messages: ChatMessage[]
  meta: { session: string; turn: string; rating: Rating; model?: string; directory?: string; title?: string }
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} caracteres cortados]` : text)
const clean = (text: string) => Lessons.redact(text)

/** A real message from the person, not one OpenCode added on its own (continue, summary, lessons). */
function written(message: SessionV1.WithParts) {
  return message.info.role === "user" && message.parts.some((part) => part.type === "text" && !part.synthetic)
}

/**
 * One turn as an example: the person's message and everything the agent did
 * for it, up to the person's next message.
 */
export function turn(messages: SessionV1.WithParts[], userMessageID: string): ChatMessage[] | undefined {
  const start = messages.findIndex((message) => message.info.id === userMessageID)
  if (start < 0) return undefined
  const rest = messages.slice(start + 1)
  const end = rest.findIndex(written)
  const replies = (end < 0 ? rest : rest.slice(0, end)).filter((message) => message.info.role === "assistant")
  const asked = messages[start]!.parts.flatMap((part) => {
    if (part.type === "text" && !part.synthetic) return [part.text]
    if (part.type === "file") return [`[arquivo anexado: ${part.filename ?? part.mime}]`]
    return []
  })
  if (!asked.length || !replies.length) return undefined
  const out: ChatMessage[] = [{ role: "user", content: clean(asked.join("\n")) }]
  for (const reply of replies) {
    const text = reply.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic)
      .map((part) => part.text)
      .join("\n")
    const tools = reply.parts.filter(
      (part): part is SessionV1.ToolPart => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
    )
    if (!text.trim() && !tools.length) continue
    out.push({
      role: "assistant",
      content: clean(text),
      ...(tools.length
        ? {
            tool_calls: tools.map((part) => ({
              id: part.callID,
              type: "function" as const,
              function: { name: part.tool, arguments: clean(JSON.stringify(part.state.input ?? {})) },
            })),
          }
        : {}),
    })
    for (const part of tools) {
      const result =
        part.state.status === "completed" ? part.state.output : part.state.status === "error" ? `Error: ${part.state.error}` : ""
      out.push({ role: "tool", tool_call_id: part.callID, content: clean(cut(result, TOOL_OUTPUT_MAX)) })
    }
  }
  // An example has to end with the agent speaking.
  return out.at(-1)?.role === "assistant" ? out : undefined
}

export function examples(
  session: { id: string; title?: string; directory?: string; metadata?: Record<string, unknown> },
  messages: SessionV1.WithParts[],
  min: "approved" | "excellent",
): Example[] {
  return Object.entries(ratings(session.metadata))
    .filter(([, rating]) => accepted(rating, min))
    .flatMap(([turnID, rating]) => {
      const chat = turn(messages, turnID)
      if (!chat) return []
      const reply = messages.find((message) => message.info.role === "assistant" && message.info.parentID === turnID)
      const model = reply?.info.role === "assistant" ? `${reply.info.providerID}/${reply.info.modelID}` : undefined
      return [{ messages: chat, meta: { session: session.id, turn: turnID, rating, model, directory: session.directory, title: session.title } }]
    })
}

/** Writes the examples as JSONL to the person's Downloads folder and returns where. */
export async function write(list: Example[], min: "approved" | "excellent", dir = path.join(os.homedir(), "Downloads")) {
  await fs.mkdir(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const file = path.join(dir, `opencode-dataset-${min}-${date}.jsonl`)
  await fs.writeFile(file, list.map((example) => JSON.stringify(example)).join("\n") + (list.length ? "\n" : ""), "utf8")
  return file
}

export * as DatasetExporter from "./export"
