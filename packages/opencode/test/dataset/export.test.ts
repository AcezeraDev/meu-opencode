import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { DatasetExporter } from "@/dataset/export"

const user = (id: string, text: string, synthetic = false) =>
  ({ info: { id, role: "user" }, parts: [{ type: "text", text, synthetic }] }) as unknown as SessionV1.WithParts
const assistant = (id: string, parentID: string, parts: unknown[]) =>
  ({ info: { id, role: "assistant", parentID, providerID: "ollama", modelID: "qwen3.5:4b" }, parts }) as unknown as SessionV1.WithParts

const session = [
  user("u1", "Crie o arquivo ola.txt com funcionou"),
  assistant("a1", "u1", [
    { type: "reasoning", text: "pensando em segredo" },
    {
      type: "tool",
      tool: "write",
      callID: "call_1",
      state: { status: "completed", input: { filePath: "ola.txt", content: "funcionou" }, output: "Wrote file" },
    },
  ]),
  // The lessons OpenCode attached and an automatic "continue" are not the person speaking.
  user("u1b", "<lessons>...</lessons>", true),
  assistant("a2", "u1", [{ type: "text", text: "Pronto, criei ola.txt." }]),
  user("u2", "Agora use a chave sk-proj-abcdefghijklmnopqrstuvwx no .env"),
  assistant("a3", "u2", [{ type: "text", text: "Coloquei OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx no .env." }]),
  user("u3", "Isso ficou ruim"),
  assistant("a4", "u3", [{ type: "text", text: "Ok." }]),
]

describe("dataset export", () => {
  test("a turn becomes chat messages with the tool calls and their results, without reasoning", () => {
    const chat = DatasetExporter.turn(session, "u1")!
    expect(chat).toEqual([
      { role: "user", content: "Crie o arquivo ola.txt com funcionou" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "write", arguments: '{"filePath":"ola.txt","content":"funcionou"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "Wrote file" },
      { role: "assistant", content: "Pronto, criei ola.txt." },
    ])
    expect(JSON.stringify(chat)).not.toContain("pensando em segredo")
  })

  test("only turns rated approved or excellent go in, and secrets never do", () => {
    const meta = { ratings: { u1: "excellent", u2: "approved", u3: "rejected" } }
    const approved = DatasetExporter.examples({ id: "s1", metadata: meta }, session, "approved")
    expect(approved.map((example) => example.meta.turn)).toEqual(["u1", "u2"])
    expect(approved[0]!.meta).toMatchObject({ session: "s1", rating: "excellent", model: "ollama/qwen3.5:4b" })
    expect(JSON.stringify(approved)).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx")
    expect(DatasetExporter.examples({ id: "s1", metadata: meta }, session, "excellent").map((example) => example.meta.turn)).toEqual(["u1"])
    expect(DatasetExporter.examples({ id: "s1", metadata: {} }, session, "approved")).toEqual([])
  })

  const dir = path.join(os.tmpdir(), `dataset-test-${process.pid}`)
  afterAll(() => fs.rm(dir, { recursive: true, force: true }))

  test("written as one JSON per line", async () => {
    const list = DatasetExporter.examples({ id: "s1", metadata: { ratings: { u1: "approved", u2: "approved" } } }, session, "approved")
    const file = await DatasetExporter.write(list, "approved", dir)
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).messages[0].role).toBe("user")
    expect(path.basename(file)).toMatch(/^opencode-dataset-approved-\d{4}-\d{2}-\d{2}\.jsonl$/)
  })
})
