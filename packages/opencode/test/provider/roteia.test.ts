import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { APICallError } from "ai"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { Roteia } from "@/provider/roteia"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * Roteia's models come from its own `GET /v1/models`. The fixture is a slice of
 * that endpoint's real response (recorded 2026-09-22): two chat models with
 * tools, one without, an embedding model and an image model.
 */
const recorded = () => Bun.file(path.join(import.meta.dir, "fixtures/roteia-models.json")).text()

/** Roteia's real answer to a missing or wrong key (from `POST /v1/chat/completions`). */
const UNAUTHORIZED = {
  error: {
    message: "chave de API inválida ou ausente",
    type: "invalid_request_error",
    code: "invalid_api_key",
    retryable: false,
    request_id: "d1b5ba10-8031-49e3-b8fc-ba9d13f58172",
    docs_url: "https://roteia.ai/docs/errors/invalid-api-key.md",
    suggested_action: "Defina ROTEIA_API_KEY com uma chave ativa e envie Authorization: Bearer $ROTEIA_API_KEY.",
  },
}

describe("Roteia models", () => {
  test("only chat models are offered, with what /v1/models says about them", async () => {
    const models = Roteia.parse(await recorded())!
    expect(Object.keys(models).sort()).toEqual([
      "deepseek/deepseek-v4-flash",
      "x-ai/grok-4.20-multi-agent",
      "z-ai/glm-5.3-flash",
    ])

    const glm = models["z-ai/glm-5.3-flash"]!
    expect(glm.providerID).toBe(Roteia.ID)
    expect(glm.name).toBe("GLM 5.3 Flash")
    expect(glm.family).toBe("z-ai")
    expect(glm.api).toEqual({
      id: "z-ai/glm-5.3-flash",
      url: "https://api.roteia.ai/v1",
      npm: "@ai-sdk/openai-compatible",
    })
    expect(glm.limit.context).toBe(1310720)
    expect(glm.capabilities.toolcall).toBe(true)
    expect(glm.capabilities.attachment).toBe(true)
    expect(glm.capabilities.input).toMatchObject({ text: true, image: true, video: true, audio: false })
    expect(glm.capabilities.temperature).toBe(true)
    // Prices are in BRL; no dollar price is made up from them.
    expect(glm.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })

    // A model that declares no tools is not offered as able to call them.
    const grok = models["x-ai/grok-4.20-multi-agent"]!
    expect(grok.capabilities.toolcall).toBe(false)
    expect(grok.capabilities.input.pdf).toBe(true)
    // DeepSeek's reasoning goes back with tool results, as for any DeepSeek model.
    expect(models["deepseek/deepseek-v4-flash"]!.capabilities.interleaved).toEqual({ field: "reasoning_content" })
  })

  test("a body that is not a model list is not taken for an empty one", () => {
    expect(Roteia.parse("<html>502 Bad Gateway</html>")).toBeUndefined()
    expect(Roteia.parse(JSON.stringify(UNAUTHORIZED))).toBeUndefined()
  })

  test("listed without models, it has no default model and does not break the provider list", () => {
    const listed = { roteia: Provider.fromModelsDevProvider(Roteia.catalogEntry) }
    expect(Provider.defaultModelIDs(listed)).toEqual({})
  })

  test("Roteia joins the catalog, unless models.dev lists it itself", () => {
    const catalog = Roteia.withCatalog({})
    expect(catalog["roteia"]).toMatchObject({ name: "Roteia", env: ["ROTEIA_API_KEY"], api: "https://api.roteia.ai/v1" })
    const listed = { roteia: { ...Roteia.catalogEntry, name: "Roteia (models.dev)" } }
    expect(Roteia.withCatalog(listed)["roteia"]!.name).toBe("Roteia (models.dev)")
  })
})

describe("Roteia errors", () => {
  const parse = (status: number, body: typeof UNAUTHORIZED) =>
    ProviderError.parseAPICallError({
      providerID: Roteia.ID,
      error: new APICallError({
        message: body.error.message,
        url: "https://api.roteia.ai/v1/chat/completions",
        requestBodyValues: {},
        statusCode: status,
        responseBody: JSON.stringify(body),
        isRetryable: status === 429 || status >= 500,
      }),
    })
  const apiError = (status: number, body: typeof UNAUTHORIZED) => {
    const parsed = parse(status, body)
    if (parsed.type !== "api_error") throw new Error(`expected an api error, got ${parsed.type}`)
    return parsed
  }

  test("a rejected key says so, with Roteia's own text and the request ID, and is not retried", () => {
    const parsed = apiError(401, UNAUTHORIZED)
    expect(parsed.message).toContain("chave de API da Roteia é inválida")
    expect(parsed.message).toContain("chave de API inválida ou ausente")
    expect(parsed.message).toContain("d1b5ba10-8031-49e3-b8fc-ba9d13f58172")
    expect(parsed.isRetryable).toBe(false)
  })

  test("balance, rate limit, missing model and upstream failures each explain themselves", () => {
    const body = (retryable: boolean) => ({ error: { ...UNAUTHORIZED.error, message: "x", retryable } })
    expect(apiError(402, body(false)).message).toContain("Saldo ou limite")
    expect(apiError(402, body(false)).isRetryable).toBe(false)
    expect(apiError(429, body(true)).message).toContain("limitou as requisições")
    expect(apiError(429, body(true)).isRetryable).toBe(true)
    expect(apiError(404, body(false)).message).toContain("não está disponível")
    expect(apiError(503, body(true)).message).toContain("HTTP 503")
    expect(apiError(503, body(true)).isRetryable).toBe(true)
  })

  test("other providers keep their messages", () => {
    const parsed = ProviderError.parseAPICallError({
      providerID: ProviderV2.ID.make("nano-gpt"),
      error: new APICallError({
        message: "Insufficient balance",
        url: "https://nano-gpt.com/api/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 402,
        responseBody: "{}",
        isRetryable: false,
      }),
    })
    expect(parsed.type === "api_error" && parsed.message).toBe("Insufficient balance")
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))

describe("Roteia as a provider", () => {
  const previous = process.env[Roteia.ENV]
  afterEach(async () => {
    if (previous === undefined) delete process.env[Roteia.ENV]
    else process.env[Roteia.ENV] = previous
    await disposeAllInstances()
  })

  // Reaches the real https://api.roteia.ai/v1/models, which lists models
  // whatever the key; a chat call with this one would be refused.
  it.instance(
    "with a key it loads, and its models come from Roteia's API",
    () =>
      Effect.gen(function* () {
        process.env[Roteia.ENV] = "rt-test-not-a-real-key"
        const providers = yield* Provider.use.list()
        const roteia = providers[Roteia.ID]
        expect(roteia).toBeDefined()
        expect(roteia!.name).toBe("Roteia")
        expect(roteia!.source).toBe("env")
        const models = Object.values(roteia!.models)
        expect(models.length).toBeGreaterThan(10)
        expect(models.every((model) => model.api.url === "https://api.roteia.ai/v1")).toBe(true)
        expect(models.some((model) => model.capabilities.toolcall)).toBe(true)
      }),
    60_000,
  )

  it.instance("without a key it stays out of the connected providers", () =>
    Effect.gen(function* () {
      delete process.env[Roteia.ENV]
      const providers = yield* Provider.use.list()
      expect(providers[Roteia.ID]).toBeUndefined()
    }),
  )
})
