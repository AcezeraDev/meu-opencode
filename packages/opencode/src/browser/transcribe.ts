import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"

/**
 * Speech to text for the extension's side panel. The browser's own dictation
 * does not work in Brave, so the panel records the person and sends the audio
 * here, and this hands it to a provider the person already has a key for.
 *
 * NanoGPT first (its whisper-large-v3 costs a fraction of a cent a minute),
 * then Roteia's whisper-1. Both speak the OpenAI transcription API.
 */

const PROVIDERS = [
  { id: "nano-gpt", url: "https://nano-gpt.com/api/v1/audio/transcriptions", model: "whisper-large-v3" },
  { id: "roteia", url: "https://api.roteia.ai/v1/audio/transcriptions", model: "openai/whisper-1" },
]

/** A minute of speech is well under this; anything bigger is not dictation. */
const MAX_BYTES = 12 * 1024 * 1024

export async function transcribe(audio: Uint8Array, mime: string): Promise<{ text: string } | { error: string }> {
  if (audio.byteLength === 0) return { error: "Não ouvi nada." }
  if (audio.byteLength > MAX_BYTES) return { error: "O áudio ficou longo demais; grave em partes menores." }
  const keys = await readKeys()
  const errors: string[] = []
  for (const provider of PROVIDERS) {
    const key = keys[provider.id]
    if (!key) continue
    const form = new FormData()
    form.append("model", provider.model)
    form.append("language", "pt")
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `ditado.${mime.includes("ogg") ? "ogg" : "webm"}`)
    const response = await fetch(provider.url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    }).catch((error: unknown) => error as Error)
    if (response instanceof Error) {
      errors.push(`${provider.id}: ${response.message}`)
      continue
    }
    const body = (await response.json().catch(() => ({}))) as { text?: string; error?: { message?: string } }
    if (response.ok && typeof body.text === "string") return { text: body.text.trim() }
    errors.push(`${provider.id}: ${body.error?.message ?? response.status}`)
  }
  if (errors.length === 0) return { error: "Nenhum provedor com transcrição configurado (NanoGPT ou Roteia)." }
  return { error: `Não deu para transcrever (${errors.join("; ")}).` }
}

/** The API keys saved in the app, by provider. */
async function readKeys(): Promise<Record<string, string>> {
  const saved = await fs
    .readFile(path.join(Global.Path.data, "auth.json"), "utf8")
    .then((text) => JSON.parse(text) as Record<string, { type?: string; key?: string }>)
    .catch(() => ({}) as Record<string, { type?: string; key?: string }>)
  return Object.fromEntries(
    Object.entries(saved).flatMap(([id, entry]) => (entry?.type === "api" && entry.key ? [[id, entry.key]] : [])),
  )
}

export * as BrowserTranscribe from "./transcribe"
