import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { makePdf } from "../fixture/pdf"

/**
 * What the model is sent, beyond the plain conversion: PDF text for models
 * that cannot take PDF files, and old browser page views left out once a newer
 * outline of the page exists.
 */

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")

function modelWith(pdf: boolean): Provider.Model {
  return {
    id: ModelV2.ID.make("test-model"),
    providerID,
    api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, input: 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  } as Provider.Model
}

const user = (id: string, parts: object[]): SessionV1.WithParts => ({
  info: {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelV2.ID.make("test-model") },
    tools: {},
    mode: "",
  } as unknown as SessionV1.User,
  parts: parts.map((part, index) => ({ ...base(id, `${id}-${index}`), ...part })) as SessionV1.Part[],
})

const assistant = (id: string, parent: string, parts: object[]): SessionV1.WithParts => ({
  info: {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID: parent,
    modelID: "test-model",
    providerID,
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Assistant,
  parts: parts.map((part, index) => ({ ...base(id, `${id}-${index}`), ...part })) as SessionV1.Part[],
})

function base(messageID: string, id: string) {
  return { id: PartID.make(`prt_${id}`), sessionID, messageID: MessageID.make(`msg_${messageID}`) }
}

function tool(callID: string, name: string, output: string, metadata: Record<string, unknown>, attachments?: object[]) {
  return {
    type: "tool",
    callID,
    tool: name,
    state: {
      status: "completed",
      input: {},
      output,
      title: name,
      metadata,
      time: { start: 0, end: 1 },
      ...(attachments ? { attachments } : {}),
    },
  }
}

/** Every tool result's text, by call id. */
function results(messages: Awaited<ReturnType<typeof MessageV2.toModelMessages>>) {
  const out: Record<string, string> = {}
  for (const message of messages) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result") continue
      const value = part.output as { type: string; value: unknown }
      out[part.toolCallId] = value.type === "text" ? String(value.value) : JSON.stringify(value.value)
    }
  }
  return out
}

const pdf = `data:application/pdf;base64,${Buffer.from(makePdf(["Plano de aula", "Exercicios de fixacao"])).toString("base64")}`

describe("PDFs for models that cannot read them", () => {
  test("a PDF the user attached reaches the model as its text", async () => {
    const input = [
      user("u1", [
        { type: "text", text: "resuma" },
        { type: "file", mime: "application/pdf", filename: "aula.pdf", url: pdf },
      ]),
    ]
    const messages = await MessageV2.toModelMessages(input, modelWith(false))
    const content = JSON.stringify(messages)
    expect(content).toContain("Exercicios de fixacao")
    expect(content).toContain("file: aula.pdf")
    expect(content).not.toContain("application/pdf")
  })

  test("a model that reads PDFs still gets the file itself", async () => {
    const input = [user("u1", [{ type: "file", mime: "application/pdf", filename: "aula.pdf", url: pdf }])]
    const content = JSON.stringify(await MessageV2.toModelMessages(input, modelWith(true)))
    expect(content).toContain("application/pdf")
    expect(content).not.toContain("Exercicios de fixacao")
  })

  test("a PDF a tool read comes back as text in the tool's result", async () => {
    const input = [
      user("u1", [{ type: "text", text: "leia" }]),
      assistant("a1", "u1", [
        tool("call-read", "read", "PDF read successfully", {}, [
          { ...base("a1", "file"), type: "file", mime: "application/pdf", filename: "aula.pdf", url: pdf },
        ]),
      ]),
    ]
    const messages = await MessageV2.toModelMessages(input, modelWith(false))
    expect(results(messages)["call-read"]).toContain("Plano de aula")
    expect(JSON.stringify(messages)).not.toContain("application/pdf")
  })
})

describe("old views of the browser page", () => {
  const big = (label: string) =>
    `url: https://moodle.test/\ntitle: ${label}\n\n` + "- text: linha do curso\n".repeat(60)

  test("only the latest outline and what follows it are sent in full", async () => {
    const input = [
      user("u1", [{ type: "text", text: "faca as atividades" }]),
      assistant("a1", "u1", [
        tool("nav1", "browser_navigate", big("Semana 15"), { refs: 40, page: "outline" }),
        tool("act1", "browser_act", big("mudanca 1"), { refs: 40, page: "change" }),
        tool("pdf1", "browser_navigate", big("PDF da aula"), { page: "pdf" }),
        tool("shot1", "browser_screenshot", "Screenshot attached.", { page: "screenshot" }, [
          { ...base("a1", "img"), type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,AAAA" },
        ]),
        tool("nav2", "browser_navigate", big("Semana 16"), { refs: 50, page: "outline" }),
        tool("act2", "browser_act", big("mudanca 2"), { refs: 50, page: "change" }),
        tool("small", "browser_act", "click ref_3 succeeded.\n\nNo visible change on the page.", { page: "change" }),
      ]),
    ]
    const out = results(await MessageV2.toModelMessages(input, modelWith(false)))
    expect(out["nav1"]).toContain("cleared")
    expect(out["act1"]).toContain("cleared")
    expect(out["shot1"]).toContain("cleared")
    // PDF text is content, not a view of the page: it stays.
    expect(out["pdf1"]).toContain("PDF da aula")
    expect(out["nav2"]).toContain("Semana 16")
    expect(out["act2"]).toContain("mudanca 2")
    expect(out["small"]).toContain("No visible change")
  })

  test("results from before the tag are recognised by their refs", async () => {
    const input = [
      user("u1", [{ type: "text", text: "abra" }]),
      assistant("a1", "u1", [
        tool("old", "browser_snapshot", big("antiga"), { format: "outline", url: "u", refs: 10 }),
        tool("new", "browser_navigate", big("nova"), { action: "goto", url: "u", refs: 12 }),
      ]),
    ]
    const out = results(await MessageV2.toModelMessages(input, modelWith(false)))
    expect(out["old"]).toContain("cleared")
    expect(out["new"]).toContain("nova")
  })

  test("an outline that left out repeated menus keeps the last whole one it leans on", async () => {
    const input = [
      user("u1", [{ type: "text", text: "faca as atividades" }]),
      assistant("a1", "u1", [
        tool("whole", "browser_navigate", big("com menu"), { refs: 40, page: "outline" }),
        tool("page2", "browser_act", big("aula 2"), { refs: 20, page: "outline", partial: true }),
        tool("page3", "browser_act", big("aula 3"), { refs: 20, page: "outline", partial: true }),
      ]),
    ]
    const out = results(await MessageV2.toModelMessages(input, modelWith(false)))
    expect(out["whole"]).toContain("com menu")
    expect(out["page2"]).toContain("cleared")
    expect(out["page3"]).toContain("aula 3")
  })

  test("what a site is remembered for stays when the page view it came with is cleared", async () => {
    const memory = '<site-memory host="moodle.test">\n1. O botão Enviar tudo pede confirmação.\n</site-memory>'
    const input = [
      user("u1", [{ type: "text", text: "faca as atividades" }]),
      assistant("a1", "u1", [
        tool("first", "browser_navigate", `${big("Semana 15")}\n\n${memory}`, { refs: 40, page: "outline" }),
        tool("next", "browser_navigate", big("Semana 16"), { refs: 50, page: "outline" }),
      ]),
    ]
    const out = results(await MessageV2.toModelMessages(input, modelWith(false)))
    expect(out["first"]).toContain("cleared")
    expect(out["first"]).not.toContain("Semana 15")
    expect(out["first"]).toContain("O botão Enviar tudo pede confirmação.")
  })

  test("a text read does not replace the outline the refs came from", async () => {
    const input = [
      user("u1", [{ type: "text", text: "leia" }]),
      assistant("a1", "u1", [
        tool("outline", "browser_navigate", big("com refs"), { refs: 10, page: "outline" }),
        tool("markdown", "browser_snapshot", big("texto"), { page: "text" }),
      ]),
    ]
    const out = results(await MessageV2.toModelMessages(input, modelWith(false)))
    expect(out["outline"]).toContain("com refs")
    expect(out["markdown"]).toContain("texto")
  })
})

describe("session titles", () => {
  test("a greeting is not what a session is about", () => {
    for (const text of [
      "oi",
      "oie",
      "oioi",
      "eae",
      "e aí",
      "opa",
      "Olá!",
      "oi, tudo bem?",
      "bom dia",
      "eae mano, beleza?",
      "o",
    ]) {
      expect(Session.isGreeting(text)).toBe(true)
    }
    for (const text of [
      "quero que faca as licoes da semana 15",
      "ta vendo a aba?",
      "oi, faz um site pra mim",
      "como eu aciono uma skill?",
      "teste",
    ]) {
      expect(Session.isGreeting(text)).toBe(false)
    }
  })
})
