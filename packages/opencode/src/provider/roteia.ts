import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Provider } from "./provider"

/**
 * Roteia, a Brazilian OpenAI-compatible gateway (https://roteia.ai).
 *
 * It is not on models.dev, where every other built-in provider and its models
 * come from, so it is described here: one catalog entry that puts it beside the
 * others, and its models read from its own `GET /v1/models`, which publishes the
 * context window, tools, vision and accepted parameters of every model.
 */

export const ID = ProviderV2.ID.make("roteia")
export const BASE_URL = "https://api.roteia.ai/v1"
/** The variable Roteia's own docs and error messages tell people to set. */
export const ENV = "ROTEIA_API_KEY"
const NPM = "@ai-sdk/openai-compatible"
/** Only these models take messages; the rest are embeddings, images and transcription. */
const CHAT_ENDPOINT = "/v1/chat/completions"
const TIMEOUT = 15_000
/** The last list that loaded, so a failed refresh keeps the models the account had. */
const CACHE = path.join(Global.Path.cache, "roteia-models.json")

export const catalogEntry: ModelsDev.Provider = {
  id: ID,
  name: "Roteia",
  env: [ENV],
  api: BASE_URL,
  npm: NPM,
  models: {},
}

/** The catalog with Roteia in it, unless models.dev has come to list it, which then wins. */
export function withCatalog<T extends ModelsDev.Provider>(catalog: Record<string, T>): Record<string, T | ModelsDev.Provider> {
  if (ID in catalog) return catalog
  return { ...catalog, [ID]: catalogEntry }
}

const ApiModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Number),
  owned_by: Schema.optional(Schema.String),
  context_length: Schema.optional(Schema.NullOr(Schema.Number)),
  endpoint: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  supported_parameters: Schema.optional(Schema.Array(Schema.String)),
  capabilities: Schema.optional(
    Schema.Struct({
      tools: Schema.optional(Schema.Boolean),
      vision: Schema.optional(Schema.Boolean),
    }),
  ),
  architecture: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Array(Schema.String)),
      output: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})
type ApiModel = Schema.Schema.Type<typeof ApiModel>

const decodeList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Unknown) })),
)
const decodeModel = Schema.decodeUnknownOption(ApiModel)

/**
 * The chat models the account can use, as OpenCode models. Read with the key,
 * since the list is per account; kept on disk, and read back from there when
 * Roteia cannot be reached, so a network hiccup does not empty the model picker.
 */
export async function discover(apiKey: string | undefined): Promise<Record<string, Provider.Model>> {
  const fresh = await fetch(`${BASE_URL}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(TIMEOUT),
  })
    .then((response) => (response.ok ? response.text() : undefined))
    .catch(() => undefined)
  const models = fresh === undefined ? undefined : parse(fresh)
  if (models && Object.keys(models).length > 0) {
    await fs
      .mkdir(path.dirname(CACHE), { recursive: true })
      .then(() => fs.writeFile(CACHE, fresh!, "utf8"))
      .catch(() => {})
    return models
  }
  return parse(await fs.readFile(CACHE, "utf8").catch(() => "")) ?? {}
}

/** Parses a `/v1/models` body; undefined when it is not one. */
export function parse(body: string): Record<string, Provider.Model> | undefined {
  const list = decodeList(body)
  if (list._tag === "None") return undefined
  return Object.fromEntries(
    list.value.data.flatMap((item) => {
      const model = decodeModel(item)
      if (model._tag === "None" || !isChatModel(model.value)) return []
      return [[model.value.id, toModel(model.value)]]
    }),
  )
}

function isChatModel(model: ApiModel) {
  if (model.endpoint !== CHAT_ENDPOINT) return false
  if (model.status !== undefined && model.status !== "available") return false
  return model.architecture?.output?.includes("text") ?? true
}

function toModel(model: ApiModel): Provider.Model {
  const input = new Set(model.architecture?.input ?? ["text"])
  const output = new Set(model.architecture?.output ?? ["text"])
  const parameters = new Set(model.supported_parameters ?? [])
  return {
    id: ModelV2.ID.make(model.id),
    providerID: ID,
    name: model.name ?? model.id,
    // The lab (z-ai, deepseek, moonshotai…): the model picker shows the newest
    // model of each family by default, so every lab gets one on screen.
    family: model.owned_by ?? "",
    api: { id: model.id, url: BASE_URL, npm: NPM },
    status: "active",
    capabilities: {
      temperature: parameters.has("temperature"),
      // Not published per model. Declaring it would make OpenCode send
      // reasoning_effort, which is not among any model's accepted parameters.
      reasoning: false,
      attachment: model.capabilities?.vision ?? input.has("image"),
      toolcall: model.capabilities?.tools ?? parameters.has("tools"),
      input: {
        text: true,
        audio: input.has("audio"),
        image: input.has("image"),
        video: input.has("video"),
        // "file" is how OpenAI-style APIs, OpenRouter included, list PDF input.
        pdf: input.has("pdf") || input.has("file"),
      },
      output: {
        text: true,
        audio: output.has("audio"),
        image: output.has("image"),
        video: output.has("video"),
        pdf: false,
      },
      // DeepSeek's thinking models require their reasoning sent back with tool
      // results; the same rule OpenCode applies to any unlisted DeepSeek model.
      interleaved: model.id.includes("deepseek") ? { field: "reasoning_content" } : false,
    },
    // Roteia prices in BRL, and OpenCode's costs are USD. Converting would need
    // an exchange rate this layer does not have, so no price is claimed.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // The maximum output is not published; 0 lets OpenCode use its default cap.
    limit: { context: model.context_length ?? 0, output: 0 },
    options: {},
    headers: {},
    release_date: model.created ? new Date(model.created * 1000).toISOString().slice(0, 10) : "",
  }
}

const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    message: Schema.optional(Schema.String),
    code: Schema.optional(Schema.NullOr(Schema.String)),
    retryable: Schema.optional(Schema.Boolean),
    request_id: Schema.optional(Schema.String),
  }),
})
const decodeError = Schema.decodeUnknownOption(ErrorBody)

/**
 * What to tell the person about a failed Roteia call, from its documented
 * statuses (https://roteia.ai/docs/errors.md) and its error envelope. Roteia's
 * own text is kept after the explanation, with the request ID its support asks
 * for; neither ever carries the key.
 */
export function describeError(status: number | undefined, body: unknown) {
  const error = decodeError(body)
  const detail = error._tag === "Some" ? error.value.error : undefined
  const lead = explain(status)
  if (!lead) return undefined
  const extra = [
    detail?.message ? `Roteia: ${detail.message}` : undefined,
    detail?.request_id ? `ID da requisição: ${detail.request_id}` : undefined,
  ].filter(Boolean)
  return {
    message: [lead, ...extra].join(" · "),
    retryable: detail?.retryable ?? (status === 429 || (status !== undefined && status >= 500)),
  }
}

function explain(status: number | undefined) {
  if (status === 400) return "A Roteia recusou a requisição."
  if (status === 401)
    return "A chave de API da Roteia é inválida, foi revogada ou está faltando. Reconecte a Roteia em Configurações → Provedores."
  if (status === 402)
    return "Saldo ou limite da chave da Roteia insuficiente. Adicione créditos ou ajuste o limite no painel da Roteia."
  if (status === 404)
    return "Este modelo não está disponível na sua conta da Roteia. Atualize a lista de modelos e escolha outro."
  if (status === 429) return "A Roteia limitou as requisições por um momento. O OpenCode tenta de novo sozinho."
  if (status !== undefined && status >= 500)
    return `A Roteia ou o provedor do modelo falhou (HTTP ${status}). Costuma ser temporário.`
  return undefined
}

/** What "Test connection" reports; never the key, only whether Roteia accepted it. */
export interface Check {
  ok: boolean
  status?: number
  message?: string
}

/**
 * Asks Roteia about the key itself (`GET /v1/key`), which fails with the same
 * statuses a chat call would: a revoked key, no balance, Roteia down.
 */
export async function check(apiKey: string): Promise<Check> {
  const response = await fetch(`${BASE_URL}/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (response instanceof Error) {
    return {
      ok: false,
      message:
        response.name === "TimeoutError"
          ? `A Roteia não respondeu em ${TIMEOUT / 1000} s. Verifique a conexão e tente de novo.`
          : "Não foi possível alcançar a Roteia. Verifique a conexão com a internet.",
    }
  }
  if (response.ok) return { ok: true, status: response.status }
  const body = await response.json().catch(() => undefined)
  return {
    ok: false,
    status: response.status,
    message: describeError(response.status, body)?.message ?? `A Roteia respondeu HTTP ${response.status}.`,
  }
}

export * as Roteia from "./roteia"
