import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { generateText, jsonSchema, streamText, tool } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { Ollama } from "@/provider/ollama"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * A stand-in for Ollama 0.35. Its answers copy what the real one sent on this
 * machine (2026-10-01): `/api/tags` with capabilities and context, a tool call
 * streamed whole with its arguments as an object, thinking in `thinking`, and
 * token counts on the `done` line.
 */
const requests: { path: string; body: any }[] = []
let delay = 0
let server: ReturnType<typeof Bun.serve>
let host = ""

const TAGS = {
  models: [
    {
      name: "qwen3:4b",
      model: "qwen3:4b",
      modified_at: "2026-08-24T19:45:10.3550888-03:00",
      size: 2497293931,
      details: { family: "qwen3", parameter_size: "4.0B", quantization_level: "Q4_K_M", context_length: 262144 },
      capabilities: ["completion", "tools", "thinking"],
    },
    {
      name: "qwen3:1.7b",
      modified_at: "2026-08-24T19:54:21.3076663-03:00",
      details: { family: "qwen3", parameter_size: "2.0B", quantization_level: "Q4_K_M", context_length: 40960 },
      capabilities: ["completion", "tools", "thinking"],
    },
    // Listed by an older Ollama: no capabilities or context, so /api/show is asked.
    { name: "llava:7b", modified_at: "2026-07-01T10:00:00Z", details: { family: "llama" } },
    {
      name: "nomic-embed-text:latest",
      details: { family: "nomic-bert", context_length: 2048 },
      capabilities: ["embedding"],
    },
  ],
}

const line = (value: unknown) => JSON.stringify(value) + "\n"

function chat(body: any) {
  if (body.model === "nao-existe") return Response.json({ error: "model 'nao-existe' not found" }, { status: 404 })
  if (body.model === "quebra")
    return new Response(
      line({ model: "quebra", message: { role: "assistant", content: "Co" }, done: false }) +
        line({ error: "model runner has unexpectedly stopped, this may be due to resource limitations" }),
    )
  const wantsTool = Array.isArray(body.tools) && body.messages.at(-1)?.role === "user"
  const done = {
    model: body.model,
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 147,
    prompt_eval_cached_count: 20,
    eval_count: 22,
  }
  const chunks = wantsTool
    ? [
        { model: body.model, message: { role: "assistant", content: "", thinking: "Vou ver o clima." }, done: false },
        {
          model: body.model,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_62wjiurn", function: { index: 0, name: "clima", arguments: { cidade: "Lisboa" } } }],
          },
          done: false,
        },
        done,
      ]
    : [
        { model: body.model, message: { role: "assistant", content: "Faz " }, done: false },
        { model: body.model, message: { role: "assistant", content: "sol." }, done: false },
        done,
      ]
  if (!body.stream) {
    return Response.json({
      ...done,
      message: { role: "assistant", content: chunks.map((c) => c.message.content).join(""), tool_calls: (chunks[1]?.message as { tool_calls?: unknown } | undefined)?.tool_calls },
    })
  }
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        await Bun.sleep(delay)
        // Lines split across network chunks, as they are in practice.
        const text = chunks.map(line).join("")
        controller.enqueue(encoder.encode(text.slice(0, 40)))
        controller.enqueue(encoder.encode(text.slice(40)))
        controller.close()
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  )
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json() : undefined
      requests.push({ path: url.pathname, body })
      if (url.pathname === "/api/version") return Response.json({ version: "0.35.0" })
      if (url.pathname === "/api/tags") return Response.json(TAGS)
      if (url.pathname === "/api/show")
        return Response.json({ capabilities: ["completion", "vision"], model_info: { "llama.context_length": 4096 } })
      if (url.pathname === "/api/chat") return chat(body)
      return new Response("not found", { status: 404 })
    },
  })
  host = `http://127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))
afterEach(() => {
  requests.length = 0
  delay = 0
})

describe("Ollama host and settings", () => {
  test("OLLAMA_HOST forms the Ollama CLI accepts become a URL to call", () => {
    expect(Ollama.normalizeHost(undefined)).toBe("http://127.0.0.1:11434")
    expect(Ollama.normalizeHost("0.0.0.0:11434")).toBe("http://127.0.0.1:11434")
    expect(Ollama.normalizeHost("localhost")).toBe("http://localhost:11434")
    expect(Ollama.normalizeHost("http://192.168.0.10:8080/")).toBe("http://192.168.0.10:8080")
    expect(Ollama.normalizeHost("https://ollama.example.com")).toBe("https://ollama.example.com")
  })

  test("config wins over the environment, and baseURL may carry /v1", () => {
    expect(Ollama.settings({ host: "http://pc:11434" }, { OLLAMA_HOST: "other:1" }).host).toBe("http://pc:11434")
    expect(Ollama.settings({ baseURL: "http://pc:11434/v1" }, {}).host).toBe("http://pc:11434")
    expect(Ollama.settings(undefined, { OLLAMA_HOST: "0.0.0.0:9999" }).host).toBe("http://127.0.0.1:9999")
    const all = Ollama.settings({ contextWindow: 16384, maxTokens: 2048, temperature: 0.2, keepAlive: "30m", think: false }, {})
    expect(all).toEqual({ host: "http://127.0.0.1:11434", contextWindow: 16384, maxTokens: 2048, temperature: 0.2, keepAlive: "30m", think: false })
  })

  test("probe says whether Ollama is running", async () => {
    expect(await Ollama.probe(host)).toBe("0.35.0")
    expect(await Ollama.probe("http://127.0.0.1:9")).toBeUndefined()
  })
})

describe("Ollama models", () => {
  test("installed chat models are listed with their context, tools, thinking and vision", async () => {
    const models = await Ollama.discover({ host })
    expect(Object.keys(models).sort()).toEqual(["llava:7b", "qwen3:1.7b", "qwen3:4b"])

    const qwen = models["qwen3:4b"]!
    expect(qwen.providerID).toBe(Ollama.ID)
    expect(qwen.name).toBe("qwen3:4b (4.0B Q4_K_M)")
    expect(qwen.family).toBe("qwen3:4b")
    expect(qwen.api).toEqual({ id: "qwen3:4b", url: `${host}/v1`, npm: "@ai-sdk/openai-compatible" })
    expect(qwen.capabilities.toolcall).toBe(true)
    expect(qwen.capabilities.reasoning).toBe(true)
    expect(qwen.capabilities.attachment).toBe(false)
    expect(qwen.cost.input).toBe(0)
    // The default context, not the 262k the model could take: that would not fit in RAM.
    expect(qwen.limit).toEqual({ context: Ollama.DEFAULT_CONTEXT, output: Ollama.DEFAULT_OUTPUT })
    expect(qwen.options).toEqual({ num_ctx: Ollama.DEFAULT_CONTEXT })

    // A model that supports less keeps its own maximum.
    const llava = models["llava:7b"]!
    expect(llava.limit.context).toBe(4096)
    expect(llava.limit.output).toBe(2048)
    expect(llava.capabilities.attachment).toBe(true)
    expect(llava.capabilities.input.image).toBe(true)
    expect(requests.some((r) => r.path === "/api/show" && r.body.model === "llava:7b")).toBe(true)
  })

  test("contextWindow and maxTokens from the config set the window and the answer cap", async () => {
    const models = await Ollama.discover({ host, contextWindow: 16384, maxTokens: 4096 })
    expect(models["qwen3:4b"]!.limit).toEqual({ context: 16384, output: 4096 })
    expect(models["qwen3:4b"]!.options).toEqual({ num_ctx: 16384 })
  })

  test("with Ollama closed there are no models, and nothing throws", async () => {
    expect(await Ollama.discover({ host: "http://127.0.0.1:9" })).toEqual({})
  })
})

describe("OpenAI requests become native Ollama requests", () => {
  test("context, answer cap, temperature, thinking and tools reach /api/chat", () => {
    const native = Ollama.toNativeRequest(
      {
        model: "qwen3:4b",
        stream: true,
        num_ctx: 32768,
        max_tokens: 8192,
        temperature: 0.3,
        reasoning_effort: "none",
        tools: [{ type: "function", function: { name: "clima", parameters: { type: "object" } } }],
        tool_choice: "auto",
        messages: [{ role: "user", content: "oi" }],
      },
      { host, keepAlive: "30m" },
    )
    expect(native).toEqual({
      model: "qwen3:4b",
      stream: true,
      think: false,
      keep_alive: "30m",
      options: { num_ctx: 32768, num_predict: 8192, temperature: 0.3 },
      tools: [{ type: "function", function: { name: "clima", parameters: { type: "object" } } }],
      messages: [{ role: "user", content: "oi" }],
    })
  })

  test("without num_ctx in the request the configured or default window is still sent", () => {
    expect(Ollama.toNativeRequest({ model: "x", messages: [] }, { host }).options.num_ctx).toBe(Ollama.DEFAULT_CONTEXT)
    expect(Ollama.toNativeRequest({ model: "x", messages: [] }, { host, contextWindow: 8192 }).options.num_ctx).toBe(8192)
  })

  test("tool calls go back with object arguments and tool results carry the tool's name", () => {
    const messages = Ollama.toNativeMessages([
      { role: "system", content: "Você é útil." },
      {
        role: "user",
        content: [
          { type: "text", text: "O que tem aqui?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        reasoning_content: "pensando",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "clima", arguments: '{"cidade":"Lisboa"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "22 °C" },
    ])
    expect(messages).toEqual([
      { role: "system", content: "Você é útil." },
      { role: "user", content: "O que tem aqui?\n[image: https://example.com/a.png]", images: ["iVBORw0KGgo="] },
      {
        role: "assistant",
        content: "",
        thinking: "pensando",
        tool_calls: [{ id: "call_1", function: { name: "clima", arguments: { cidade: "Lisboa" } } }],
      },
      { role: "tool", content: "22 °C", tool_call_id: "call_1", tool_name: "clima" },
    ])
  })
})

describe("the OpenAI-compatible SDK through the adapter", () => {
  const model = (name = "qwen3:4b", settings: Partial<Ollama.Settings> = {}) =>
    createOpenAICompatible({
      name: "ollama",
      baseURL: `${host}/v1`,
      apiKey: "ollama",
      includeUsage: true,
      fetch: Ollama.createFetch({ host, ...settings }),
    }).chatModel(name)

  const clima = tool({
    description: "clima da cidade",
    inputSchema: jsonSchema<{ cidade: string }>({
      type: "object",
      properties: { cidade: { type: "string" } },
      required: ["cidade"],
    }),
  })

  test("a streamed answer with thinking and a tool call arrives as the SDK expects", async () => {
    const result = streamText({
      model: model(),
      messages: [{ role: "user", content: "Qual o clima em Lisboa?" }],
      tools: { clima },
      providerOptions: { ollama: { num_ctx: 16384 } },
      maxOutputTokens: 1000,
    })
    const reasoning = await result.reasoningText
    const calls = await result.toolCalls
    const usage = await result.usage
    expect(reasoning).toBe("Vou ver o clima.")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolName).toBe("clima")
    expect(calls[0]!.toolCallId).toBe("call_62wjiurn")
    expect(calls[0]!.input).toEqual({ cidade: "Lisboa" })
    expect(await result.finishReason).toBe("tool-calls")
    // prompt_eval_count already includes the cached part; counting it twice made OpenCode compact every turn.
    expect(usage.inputTokens).toBe(147)
    expect(usage.outputTokens).toBe(22)

    const sent = requests.find((r) => r.path === "/api/chat")!.body
    expect(sent.options.num_ctx).toBe(16384)
    expect(sent.options.num_predict).toBe(1000)
    expect(sent.tools[0].function.name).toBe("clima")
    expect(requests.some((r) => r.path.startsWith("/v1"))).toBe(false)
  })

  test("plain text streams and finishes with stop", async () => {
    const result = streamText({ model: model(), messages: [{ role: "user", content: "e o tempo?" }] })
    expect(await result.text).toBe("Faz sol.")
    expect(await result.finishReason).toBe("stop")
  })

  test("a non-streamed call works too", async () => {
    const result = await generateText({ model: model(), messages: [{ role: "user", content: "e o tempo?" }] })
    expect(result.text).toBe("Faz sol.")
    expect(result.usage.inputTokens).toBe(147)
  })

  test("a model that takes long to read the prompt still answers", async () => {
    delay = 3_500
    const result = streamText({ model: model(), messages: [{ role: "user", content: "e o tempo?" }] })
    expect(await result.text).toBe("Faz sol.")
  }, 15_000)

  test("cancelling while Ollama is still reading the prompt stops the request", async () => {
    delay = 5_000
    const controller = new AbortController()
    const result = streamText({
      model: model(),
      messages: [{ role: "user", content: "e o tempo?" }],
      abortSignal: controller.signal,
    })
    setTimeout(() => controller.abort(), 500)
    const started = Date.now()
    const text = await result.text.then(
      (value) => value,
      (error: Error) => error,
    )
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(text instanceof Error ? text.name : text).not.toBe("Faz sol.")
  }, 15_000)

  test("an error in the middle of the stream reaches the caller", async () => {
    const result = streamText({ model: model("quebra"), messages: [{ role: "user", content: "oi" }] })
    const errors: unknown[] = []
    for await (const part of result.fullStream) if (part.type === "error") errors.push(part.error)
    expect(JSON.stringify(errors)).toContain("Ollama: model runner has unexpectedly stopped")
  })

  test("a missing model says how to install it", async () => {
    const error = await generateText({ model: model("nao-existe"), messages: [{ role: "user", content: "oi" }], maxRetries: 0 }).then(
      () => undefined,
      (error: Error) => error,
    )
    expect(error?.message).toContain("ollama pull nao-existe")
  })

  test("Ollama closed says to open it, without retrying", async () => {
    const closed = createOpenAICompatible({
      name: "ollama",
      baseURL: "http://127.0.0.1:9/v1",
      fetch: Ollama.createFetch({ host: "http://127.0.0.1:9" }),
    }).chatModel("qwen3:4b")
    const error = await generateText({ model: closed, messages: [{ role: "user", content: "oi" }] }).then(
      () => undefined,
      (error: Error) => error,
    )
    expect(error?.message).toContain("O Ollama não está respondendo")
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))

describe("Ollama as a provider", () => {
  const previous = process.env.OLLAMA_HOST
  afterEach(async () => {
    if (previous === undefined) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = previous
    await disposeAllInstances()
  })

  it.instance("when Ollama answers it is connected, with the installed models", () =>
    Effect.gen(function* () {
      process.env.OLLAMA_HOST = host
      const providers = yield* Provider.use.list()
      const ollama = providers[Ollama.ID]
      expect(ollama).toBeDefined()
      expect(ollama!.name).toBe("Ollama (local)")
      expect(Object.keys(ollama!.models).sort()).toEqual(["llava:7b", "qwen3:1.7b", "qwen3:4b"])
      expect(ollama!.models["qwen3:4b"]!.api.url).toBe(`${host}/v1`)
    }),
  )

  it.instance("with another provider connected, a local model is not made the default", () =>
    Effect.gen(function* () {
      process.env.OLLAMA_HOST = host
      const key = process.env.ANTHROPIC_API_KEY
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real"
      const chosen = yield* Provider.use.defaultModel()
      if (key === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = key
      expect(chosen.providerID).not.toBe(Ollama.ID)
    }),
  )

  it.instance("when Ollama is closed it stays out of the connected providers", () =>
    Effect.gen(function* () {
      process.env.OLLAMA_HOST = "http://127.0.0.1:9"
      const providers = yield* Provider.use.list()
      expect(providers[Ollama.ID]).toBeUndefined()
    }),
  )
})
