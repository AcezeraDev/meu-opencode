import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { VisionEvaluator } from "@/evaluate/vision"
import type { BrowserQA } from "@/browser/qa"
import type { Provider } from "@/provider/provider"

const ANSWER = {
  status: "needs_changes",
  score: 6,
  issues: [
    {
      severity: "high",
      viewport: "mobile",
      page: "/",
      area: "banner",
      problem: "O banner passa da borda direita em 390px e corta o texto",
      fix: "max-width: 100% e padding lateral de 16px",
    },
  ],
  strengths: ["Título claro"],
  suggestions: ["Aumentar o contraste do texto de frete"],
  requires_fix: true,
}

describe("reading the evaluation", () => {
  test("a JSON answer, with fences and text around it", () => {
    expect(VisionEvaluator.parse("```json\n" + JSON.stringify(ANSWER) + "\n```")?.issues[0]?.area).toBe("banner")
    expect(VisionEvaluator.parse("Segue a avaliação:\n" + JSON.stringify(ANSWER) + "\nFim.")?.score).toBe(6)
  })

  test("serious issues cannot come back as approved", () => {
    const sloppy = { ...ANSWER, status: "approved", requires_fix: false }
    const review = VisionEvaluator.parse(JSON.stringify(sloppy))!
    expect(review.status).toBe("needs_changes")
    expect(review.requires_fix).toBe(true)
  })

  test("a small model that leaves out status and requires_fix still gives a usable review", () => {
    // Seen with qwen3.5:4b: everything but requires_fix.
    const { requires_fix: _, ...partial } = ANSWER
    expect(VisionEvaluator.parse(JSON.stringify(partial))?.requires_fix).toBe(true)
    const minor = VisionEvaluator.parse(JSON.stringify({ issues: [{ severity: "low", problem: "Ícone 2px acima do texto" }] }))!
    expect(minor.status).toBe("approved")
    expect(minor.strengths).toEqual([])
  })

  test("an answer outside the shape is not taken as a review", () => {
    expect(VisionEvaluator.parse("Ficou bonito!")).toBeUndefined()
    expect(VisionEvaluator.parse(JSON.stringify({ status: "ok" }))).toBeUndefined()
  })

  test("the report reads as a decision with concrete issues", () => {
    const text = VisionEvaluator.render({ review: VisionEvaluator.parse(JSON.stringify(ANSWER)), raw: "" }, "ollama/qwen3.5:4b")
    expect(text).toContain("PRECISA DE AJUSTES")
    expect(text).toContain("[high] (mobile) / banner: O banner passa da borda")
    expect(text).toContain("→ max-width: 100%")
  })
})

describe("asking a vision model", () => {
  let dir: string
  let server: ReturnType<typeof Bun.serve>
  let received: any

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-test-"))
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        received = await request.json()
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        const text = JSON.stringify(ANSWER)
        return new Response(
          chunk({ role: "assistant", content: text.slice(0, 40) }) + chunk({ content: text.slice(40) }) + chunk({}, "stop") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
  })
  afterAll(() => server.stop(true))

  test("the screenshots and the measured problems are sent, and the answer is kept with the check", async () => {
    const shots = await Promise.all(
      (["desktop", "tablet", "mobile"] as const).map(async (viewport) => {
        const file = path.join(dir, `inicio-${viewport}.jpg`)
        await fs.writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
        return { page: "http://localhost:3000/", viewport, file }
      }),
    )
    const report: BrowserQA.Report = {
      id: "r1",
      url: "http://localhost:3000/",
      origin: "http://localhost:3000",
      time: 0,
      pages: ["http://localhost:3000/"],
      viewports: ["desktop", "tablet", "mobile"],
      issues: [{ severity: "error", kind: "overflow", page: "http://localhost:3000/", viewport: "mobile", message: "Rolagem horizontal" }],
      shots,
    }
    const language = createOpenAICompatible({ name: "fake", baseURL: `http://127.0.0.1:${server.port}/v1` }).chatModel("m")
    const model = { id: "m", providerID: "fake", options: {}, api: { npm: "@ai-sdk/openai-compatible" } } as unknown as Provider.Model
    const result = await VisionEvaluator.review({ report, language, model, focus: "o banner" })

    expect(result.review?.requires_fix).toBe(true)
    const content = received.messages.find((message: any) => message.role === "user").content
    expect(content.filter((part: any) => part.type === "image_url")).toHaveLength(3)
    const text = content.find((part: any) => part.type === "text").text
    expect(text).toContain("Rolagem horizontal")
    expect(text).toContain("Foco pedido: o banner")
    expect(received.messages[0].role).toBe("system")
    const saved = JSON.parse(await fs.readFile(path.join(dir, "review.json"), "utf8"))
    expect(saved.review.issues[0].area).toBe("banner")
  })
})
