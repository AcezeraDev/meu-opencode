import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Writer } from "../../src/writer/writer"

const user = () => ({ info: { role: "user" }, parts: [{ type: "text", text: "oi" }] }) as unknown as SessionV1.WithParts
const writer = (status: "completed" | "error") =>
  ({ info: { role: "assistant" }, parts: [{ type: "tool", tool: "write_text", state: { status } }] }) as unknown as SessionV1.WithParts
const essay = Array(60).fill("O versionamento de código ajuda a equipe.").join(" ")

describe("Writer", () => {
  test("expands a saved text exactly as written", async () => {
    const text = 'Introdução\n\nUm texto com "aspas", acentuação e $& especiais.'
    const id = await Writer.save(text)
    expect(await Writer.expand(Writer.reference(id))).toBe(text)
    expect(await Writer.expand(`Antes ${Writer.reference(id)} depois`)).toBe(`Antes ${text} depois`)
  })

  test("leaves text without references alone", async () => {
    expect(await Writer.expand("texto comum @ email")).toBe("texto comum @ email")
  })

  test("an unknown id says to write the text again", async () => {
    expect(Writer.expand("@texto:naoexiste")).rejects.toThrow("write_text")
  })

  test("long prose of the agent's own goes through the writer when one is set", () => {
    expect(Writer.guard(essay, true, [user()])).toContain("write_text")
    expect(Writer.guard(essay, false, [user()])).toBeUndefined()
  })

  test("short texts, references and non-prose are typed as they are", () => {
    expect(Writer.guard("Maria da Silva", true, [user()])).toBeUndefined()
    expect(Writer.guard("@texto:abc123", true, [user()])).toBeUndefined()
    expect(Writer.guard(Array(80).fill("12345").join(" "), true, [user()])).toBeUndefined()
  })

  test("after the writer failed in this request, the agent's own text is allowed", () => {
    expect(Writer.guard(essay, true, [user(), writer("error")])).toBeUndefined()
    expect(Writer.guard(essay, true, [user(), writer("completed")])).toContain("write_text")
    // A failure in an earlier request does not count.
    expect(Writer.guard(essay, true, [user(), writer("error"), user()])).toContain("write_text")
  })
})
