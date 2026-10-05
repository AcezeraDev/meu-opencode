import http from "node:http"
import https from "node:https"
import { Readable } from "node:stream"
import { Schema } from "effect"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Provider } from "./provider"

/**
 * Ollama running on this machine (https://ollama.com), as a first-class provider.
 *
 * Its models are whatever is installed (`GET /api/tags`), so they are listed
 * from there and show up in the model picker without editing any config.
 *
 * Chats do NOT go through Ollama's OpenAI-compatible `/v1` endpoint: measured on
 * Ollama 0.35, `/v1/chat/completions` always loads the model with a 4096-token
 * context and ignores `num_ctx` (in `options`, at the top level or in
 * `extra_body`). OpenCode's system prompt alone is larger than that, so the
 * model silently lost most of it. The OpenAI-compatible SDK is kept (it is what
 * the rest of OpenCode speaks) and its requests are translated here to the
 * native `POST /api/chat`, which honors `num_ctx`, `num_predict`, `temperature`,
 * `think` and `keep_alive`.
 *
 * Settings, all optional, in `provider.ollama.options` of opencode.jsonc:
 * `host` (or `baseURL`), `contextWindow`, `maxTokens`, `temperature`,
 * `keepAlive`, `think`. `OLLAMA_HOST` is read too, like the Ollama CLI does.
 */

export const ID = ProviderV2.ID.make("ollama")
export const DEFAULT_HOST = "http://127.0.0.1:11434"
const NPM = "@ai-sdk/openai-compatible"
/**
 * Context used when the config does not say: room for OpenCode's system prompt,
 * tools and a working conversation, while still fitting a 4–8B model and its
 * KV cache in 16 GB of RAM. Models that support less get their own maximum.
 */
export const DEFAULT_CONTEXT = 32_768
/** Cap on one answer; also what compaction keeps free at the end of the context. */
export const DEFAULT_OUTPUT = 8_192
const PROBE_TIMEOUT = 1_500
const LIST_TIMEOUT = 5_000
/** How long a request may wait for Ollama's first byte before the answer is streamed anyway. */
const HEADER_WINDOW = 3_000
/** SSE comment sent while a slow CPU is still reading the prompt, so no timeout fires. */
const KEEPALIVE = 10_000

export const catalogEntry: ModelsDev.Provider = {
  id: ID,
  name: "Ollama (local)",
  env: [],
  api: `${DEFAULT_HOST}/v1`,
  npm: NPM,
  models: {},
}

/** The catalog with local Ollama in it, unless models.dev comes to list it, which then wins. */
export function withCatalog<T extends ModelsDev.Provider>(catalog: Record<string, T>): Record<string, T | ModelsDev.Provider> {
  if (ID in catalog) return catalog
  return { ...catalog, [ID]: catalogEntry }
}

/**
 * The tools a local model gets by default. Measured 2026-10-01: OpenCode sent a
 * local model ~77k characters before the request, three quarters of them tool
 * descriptions; on a laptop CPU that is ten minutes of reading before the
 * first word. This keeps coding, the terminal, the plan and the essential
 * browser (open, act, read, screenshot) and drops what a small local model
 * rarely uses well: video generation, browser programs and notes, inspection,
 * subagents, questions and the skills list. `options.lean: false` turns it off.
 */
export const LEAN_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "glob",
  "grep",
  "bash",
  "shell_jobs",
  "preview",
  "todowrite",
  "lessons",
  "webfetch",
  "websearch",
  "browser_navigate",
  "browser_act",
  "browser_snapshot",
  "browser_find",
  "browser_screenshot",
  "site_check",
  "visual_review",
])

/** Whether requests to this provider use the lean profile. */
export function lean(providerID: string, options: Record<string, unknown> | undefined) {
  return providerID === ID && options?.lean !== false
}

export interface Settings {
  host: string
  contextWindow?: number
  maxTokens?: number
  temperature?: number
  keepAlive?: string | number
  think?: boolean
}

const positive = (value: unknown) => (typeof value === "number" && value > 0 ? Math.floor(value) : undefined)

/** Settings from the provider's config options and the environment. */
export function settings(options: Record<string, unknown> | undefined, env: Record<string, string | undefined>): Settings {
  const configured =
    typeof options?.host === "string" && options.host
      ? options.host
      : typeof options?.baseURL === "string" && options.baseURL
        ? options.baseURL.replace(/\/v1\/?$/, "")
        : env.OLLAMA_HOST
  return {
    host: normalizeHost(configured),
    contextWindow: positive(options?.contextWindow),
    maxTokens: positive(options?.maxTokens),
    temperature: typeof options?.temperature === "number" ? options.temperature : undefined,
    keepAlive:
      typeof options?.keepAlive === "string" || typeof options?.keepAlive === "number" ? options.keepAlive : undefined,
    think: typeof options?.think === "boolean" ? options.think : undefined,
  }
}

/** `OLLAMA_HOST` may be `0.0.0.0:11434` or `localhost`; this makes it a URL to call. */
export function normalizeHost(value: string | undefined) {
  const raw = value?.trim()
  if (!raw) return DEFAULT_HOST
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`
  const url = new URL(withScheme)
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
  if (!url.port && !/^https?:\/\/[^/]+:\d+/.test(withScheme) && url.protocol === "http:") url.port = "11434"
  return url.origin + url.pathname.replace(/\/+$/, "")
}

/** Ollama's version when it answers, undefined when it is not running. */
export async function probe(host: string) {
  const body = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined)
  return typeof body?.version === "string" ? (body.version as string) : undefined
}

const Tag = Schema.Struct({
  name: Schema.String,
  model: Schema.optional(Schema.String),
  modified_at: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  details: Schema.optional(
    Schema.Struct({
      family: Schema.optional(Schema.String),
      parameter_size: Schema.optional(Schema.String),
      quantization_level: Schema.optional(Schema.String),
      context_length: Schema.optional(Schema.Number),
    }),
  ),
})
export type Tag = Schema.Schema.Type<typeof Tag>
const decodeTags = Schema.decodeUnknownOption(Schema.Struct({ models: Schema.Array(Schema.Unknown) }))
const decodeTag = Schema.decodeUnknownOption(Tag)

/** The installed models as Ollama lists them; empty when Ollama is not reachable. */
export async function tags(host: string): Promise<Tag[]> {
  const body = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(LIST_TIMEOUT) })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined)
  const list = decodeTags(body)
  if (list._tag === "None") return []
  const parsed = list.value.models.flatMap((item) => {
    const tag = decodeTag(item)
    return tag._tag === "Some" ? [tag.value] : []
  })
  // Ollama older than ~0.11 leaves capabilities and context out of the list;
  // `/api/show` has them for every version.
  return Promise.all(parsed.map((tag) => (tag.capabilities && tag.details?.context_length ? tag : show(host, tag))))
}

async function show(host: string, tag: Tag): Promise<Tag> {
  const body = await fetch(`${host}/api/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: tag.name }),
    signal: AbortSignal.timeout(LIST_TIMEOUT),
  })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined)
  if (!body || typeof body !== "object") return tag
  const info = (body as { model_info?: Record<string, unknown> }).model_info ?? {}
  const context = Object.entries(info).find(([key]) => key.endsWith(".context_length"))?.[1]
  const capabilities = (body as { capabilities?: unknown }).capabilities
  return {
    ...tag,
    capabilities: tag.capabilities ?? (Array.isArray(capabilities) ? capabilities.filter((c) => typeof c === "string") : undefined),
    details: { ...tag.details, context_length: tag.details?.context_length ?? (typeof context === "number" ? context : undefined) },
  }
}

/** The installed chat models, as OpenCode models. Embedding-only models are left out. */
export async function discover(input: Settings): Promise<Record<string, Provider.Model>> {
  const list = await tags(input.host)
  return Object.fromEntries(
    list.filter((tag) => isChatModel(tag)).map((tag) => [tag.name, toModel(tag, input)] as const),
  )
}

function isChatModel(tag: Tag) {
  if (!tag.capabilities) return true
  return tag.capabilities.includes("completion")
}

export function toModel(tag: Tag, input: Settings): Provider.Model {
  const capabilities = new Set(tag.capabilities ?? ["completion"])
  const wanted = input.contextWindow ?? DEFAULT_CONTEXT
  const context = Math.min(wanted, tag.details?.context_length ?? wanted)
  const output = Math.min(input.maxTokens ?? DEFAULT_OUTPUT, Math.floor(context / 2))
  const size = [tag.details?.parameter_size, tag.details?.quantization_level].filter(Boolean).join(" ")
  return {
    id: ModelV2.ID.make(tag.name),
    providerID: ID,
    name: size ? `${tag.name} (${size})` : tag.name,
    // The model picker shows one model per family; every installed model was
    // pulled on purpose, so each one is its own.
    family: tag.name,
    api: { id: tag.name, url: `${input.host}/v1`, npm: NPM },
    status: "active",
    capabilities: {
      temperature: true,
      reasoning: capabilities.has("thinking"),
      attachment: capabilities.has("vision"),
      toolcall: capabilities.has("tools"),
      input: { text: true, audio: false, image: capabilities.has("vision"), video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // limit.context is what compaction plans around, and num_ctx is what Ollama
    // loads: they must be the same number, or the model is cut off silently.
    limit: { context, output },
    options: { num_ctx: context },
    headers: {},
    release_date: tag.modified_at?.slice(0, 10) ?? "",
  }
}

// ---------------------------------------------------------------------------
// OpenAI chat-completions  →  Ollama /api/chat

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** OpenAI-style messages as Ollama's native chat takes them. */
export function toNativeMessages(messages: unknown[]) {
  const names = new Map<string, string>()
  return messages.filter(isRecord).map((message) => {
    const role = String(message.role)
    const { text, images } = splitContent(message.content)
    if (role === "assistant") {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : []
      calls.forEach((call) => {
        if (typeof call.id === "string" && isRecord(call.function)) names.set(call.id, String(call.function.name))
      })
      return {
        role,
        content: text,
        ...(typeof message.reasoning_content === "string" ? { thinking: message.reasoning_content } : {}),
        ...(calls.length
          ? {
              tool_calls: calls.map((call) => {
                const fn = isRecord(call.function) ? call.function : {}
                return { ...(typeof call.id === "string" ? { id: call.id } : {}), function: { name: String(fn.name), arguments: parseArguments(fn.arguments) } }
              }),
            }
          : {}),
      }
    }
    if (role === "tool") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : undefined
      return {
        role,
        content: text,
        ...(id ? { tool_call_id: id } : {}),
        ...(id && names.has(id) ? { tool_name: names.get(id) } : {}),
      }
    }
    return { role, content: text, ...(images.length ? { images } : {}) }
  })
}

function splitContent(content: unknown) {
  if (typeof content === "string") return { text: content, images: [] as string[] }
  if (!Array.isArray(content)) return { text: "", images: [] as string[] }
  const parts = content.filter(isRecord)
  const images = parts.flatMap((part) => {
    if (part.type !== "image_url") return []
    const url = isRecord(part.image_url) ? part.image_url.url : part.image_url
    const match = typeof url === "string" ? /^data:[^;]+;base64,(.*)$/s.exec(url) : null
    return match ? [match[1]] : []
  })
  const text = parts
    .flatMap((part) => {
      if (part.type === "text" && typeof part.text === "string") return [part.text]
      // Ollama only takes inline images; a remote one is named so the model knows it was there.
      if (part.type === "image_url") {
        const url = isRecord(part.image_url) ? part.image_url.url : part.image_url
        return typeof url === "string" && !url.startsWith("data:") ? [`[image: ${url}]`] : []
      }
      return []
    })
    .join("\n")
  return { text, images }
}

function parseArguments(value: unknown): Json {
  if (isRecord(value)) return value
  if (typeof value !== "string" || !value.trim()) return {}
  const parsed = (() => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  })()
  return isRecord(parsed) ? parsed : { input: value }
}

/** The body for `POST /api/chat` from an OpenAI chat-completions body. */
export function toNativeRequest(body: Json, input: Settings) {
  const responseFormat = isRecord(body.response_format) ? body.response_format : undefined
  const schema =
    responseFormat?.type === "json_schema" && isRecord(responseFormat.json_schema)
      ? responseFormat.json_schema.schema
      : undefined
  const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined
  const think = typeof body.think === "boolean" ? body.think : effort ? effort !== "none" : input.think
  const options = Object.fromEntries(
    Object.entries({
      num_ctx: positive(body.num_ctx) ?? input.contextWindow ?? DEFAULT_CONTEXT,
      num_predict: positive(body.max_tokens) ?? positive(body.max_completion_tokens) ?? input.maxTokens,
      temperature: typeof body.temperature === "number" ? body.temperature : input.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      seed: body.seed,
      stop: body.stop,
      presence_penalty: body.presence_penalty,
      frequency_penalty: body.frequency_penalty,
      ...(isRecord(body.options) ? body.options : {}),
    }).filter(([, value]) => value !== undefined && value !== null),
  )
  return {
    model: body.model,
    messages: toNativeMessages(Array.isArray(body.messages) ? body.messages : []),
    stream: body.stream === true,
    options,
    ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
    ...(think !== undefined ? { think } : {}),
    ...((body.keep_alive ?? input.keepAlive) !== undefined ? { keep_alive: body.keep_alive ?? input.keepAlive } : {}),
    ...(schema ? { format: schema } : responseFormat?.type === "json_object" ? { format: "json" } : {}),
  }
}

interface NativeChunk {
  model?: string
  created_at?: string
  message?: { content?: string; thinking?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  prompt_eval_cached_count?: number
  eval_count?: number
  error?: string
}

/**
 * `prompt_eval_count` is the whole prompt, cached part included (measured: the
 * same 1117-token prompt twice gives 1117 both times, with 3 then 1116 cached).
 * Adding the cache on top counted every step twice and made OpenCode compact
 * the session after each answer.
 */
function usage(chunk: NativeChunk) {
  const prompt = chunk.prompt_eval_count ?? 0
  const cached = Math.min(chunk.prompt_eval_cached_count ?? 0, prompt)
  const completion = chunk.eval_count ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
  }
}

const callID = () => `call_${Math.random().toString(36).slice(2, 12)}`

function toolCalls(chunk: NativeChunk, start: number) {
  return (chunk.message?.tool_calls ?? []).map((call, index) => ({
    index: start + index,
    id: call.id ?? callID(),
    type: "function",
    function: {
      name: call.function?.name ?? "",
      arguments: JSON.stringify(isRecord(call.function?.arguments) ? call.function.arguments : parseArguments(call.function?.arguments)),
    },
  }))
}

function finishReason(chunk: NativeChunk, calledTools: boolean) {
  if (calledTools) return "tool_calls"
  return chunk.done_reason === "length" ? "length" : "stop"
}

/** A whole (non-streamed) native answer as an OpenAI chat completion. */
export function toCompletion(chunk: NativeChunk) {
  const calls = toolCalls(chunk, 0)
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: chunk.model ?? "",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: chunk.message?.content ?? "",
          ...(chunk.message?.thinking ? { reasoning_content: chunk.message.thinking } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: finishReason(chunk, calls.length > 0),
      },
    ],
    usage: usage(chunk),
  }
}

/**
 * Ollama's NDJSON stream as the OpenAI SSE stream the SDK reads: thinking as
 * `reasoning_content`, text as `content`, each tool call complete in one delta
 * (Ollama never splits one), and usage with the last chunk.
 */
export function toEventStream(lines: AsyncIterable<NativeChunk>, keepalive = KEEPALIVE) {
  const encoder = new TextEncoder()
  const id = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      const timer = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), keepalive)
      const chunk = (model: string | undefined, delta: Json, finish: string | null = null, extra: Json = {}) =>
        send({ id, object: "chat.completion.chunk", created, model: model ?? "", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
      let calls = 0
      try {
        for await (const line of lines) {
          if (line.error) {
            send({ error: { message: line.error } })
            break
          }
          const message = line.message
          if (message?.thinking) chunk(line.model, { reasoning_content: message.thinking })
          if (message?.content) chunk(line.model, { content: message.content })
          const deltas = toolCalls(line, calls)
          if (deltas.length) {
            calls += deltas.length
            chunk(line.model, { tool_calls: deltas })
          }
          if (line.done) {
            chunk(line.model, {}, finishReason(line, calls > 0), { usage: usage(line) })
            break
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        clearInterval(timer)
      }
    },
  })
}

/** Reads an NDJSON body line by line. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncIterable<NativeChunk> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split("\n")
    buffer = done ? "" : (lines.pop() ?? "")
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) yield JSON.parse(trimmed) as NativeChunk
    }
    if (done) return
  }
}

function errorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message, type: "ollama_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** What to tell the person about a failed call, with Ollama's own text. */
export function describeError(status: number, text: string, host: string, model: unknown) {
  const detail = (() => {
    try {
      const body = JSON.parse(text) as unknown
      return isRecord(body) && typeof body.error === "string" ? body.error : text
    } catch {
      return text
    }
  })()
  if (status === 404)
    return `O modelo "${String(model)}" não está instalado no Ollama. Rode \`ollama pull ${String(model)}\` ou escolha outro. (Ollama: ${detail})`
  if (/memory/i.test(detail))
    return `Falta memória para carregar "${String(model)}" com este contexto. Escolha um modelo menor ou diminua provider.ollama.options.contextWindow. (Ollama: ${detail})`
  return `Ollama em ${host} respondeu HTTP ${status}: ${detail}`
}

/**
 * A `fetch` for the OpenAI-compatible SDK that sends chat completions to
 * Ollama's native `/api/chat`. Everything else passes through untouched.
 */
/** Why a call never got an answer: Ollama closed, or the connection broke. */
function unreachable(error: Error, host: string) {
  const code = (error as NodeJS.ErrnoException).code
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH")
    return `O Ollama não está respondendo em ${host}. Abra o Ollama (ou rode \`ollama serve\`) e tente de novo.`
  return `A conexão com o Ollama em ${host} caiu (${code ?? error.message}). Se o Ollama fechou ou ficou sem memória, abra de novo e tente outra vez.`
}

/**
 * POST with `node:http`, not `fetch`: both Bun's fetch and Node's (undici)
 * give up after 300 s without response headers, and Ollama sends its headers
 * with the first token. On a laptop CPU, reading OpenCode's prompt can take
 * longer than that, so the wait here has no limit; cancelling still works.
 */
function post(url: string, body: string, signal?: AbortSignal | null) {
  return new Promise<Response>((resolve, reject) => {
    const target = new URL(url)
    const request = (target.protocol === "https:" ? https : http).request(
      target,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (response) => {
        const stream = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>
        resolve(new Response(stream, { status: response.statusCode ?? 500 }))
      },
    )
    const abort = () => {
      const reason = new Error("The operation was aborted")
      reason.name = "AbortError"
      request.destroy(reason)
      reject(reason)
    }
    if (signal?.aborted) return abort()
    signal?.addEventListener("abort", abort, { once: true })
    request.on("error", reject)
    request.on("close", () => signal?.removeEventListener("abort", abort))
    request.end(body)
  })
}

export function createFetch(input: Settings, base: typeof fetch = fetch): typeof fetch {
  const adapter = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = request instanceof Request ? request.url : String(request)
    if (!url.endsWith("/chat/completions") || typeof init?.body !== "string") return base(request, init)
    const body = JSON.parse(init.body) as Json
    const native = toNativeRequest(body, input)
    const upstream = post(`${input.host}/api/chat`, JSON.stringify(native), init.signal).then(
      (response) => response,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    )

    const failed = async (response: Response | Error) => {
      if (response instanceof Error) {
        if (response.name === "AbortError" || init.signal?.aborted) throw response
        // 424: not retried. Ollama being closed will not fix itself in a few seconds.
        return errorResponse(424, unreachable(response, input.host))
      }
      return errorResponse(response.status, describeError(response.status, await response.text(), input.host, body.model))
    }

    if (!native.stream) {
      const response = await upstream
      if (response instanceof Error || !response.ok) return failed(response)
      return new Response(JSON.stringify(toCompletion((await response.json()) as NativeChunk)), {
        headers: { "content-type": "application/json" },
      })
    }

    // A small model on a laptop CPU can take minutes to read a long prompt
    // before its first token. Errors (model missing, no memory) arrive at once,
    // so they keep their HTTP status; after a short wait the stream is opened
    // and kept alive while Ollama is still reading.
    const early = await Promise.race([
      upstream,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), HEADER_WINDOW)),
    ])
    if (early instanceof Error || (early && !early.ok)) return failed(early)
    const lines = (async function* () {
      const response = early ?? (await upstream)
      if (response instanceof Error) {
        if (response.name === "AbortError") throw response
        yield { error: unreachable(response, input.host) } satisfies NativeChunk
        return
      }
      if (!response.ok) {
        yield { error: describeError(response.status, await response.text(), input.host, body.model) } satisfies NativeChunk
        return
      }
      if (!response.body) return
      // An error Ollama reports in the middle of the stream (the model crashed, ran out of memory).
      for await (const line of readLines(response.body))
        yield line.error ? { ...line, error: `Ollama: ${line.error}` } : line
    })()
    return new Response(toEventStream(lines), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }
  // Bun's fetch type also carries preconnect; the SDK only ever calls it.
  return Object.assign(adapter, { preconnect: base.preconnect })
}

export * as Ollama from "./ollama"
