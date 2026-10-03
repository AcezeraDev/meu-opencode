import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { Lessons } from "@/memory/lessons"

afterEach(async () => {
  await fs.rm(Lessons.dir(), { recursive: true, force: true })
})

const hydration: Lessons.Draft = {
  problem: "React hydration mismatch: Text content does not match server-rendered HTML",
  cause: "Date.now() rendered on the server and again on the client",
  solution: "Render the date only after mount (useEffect) or pass it from the server as a prop",
  result: "Error gone in the console; page checked in the browser",
  tags: ["react", "nextjs", "hydration"],
  project: "C:\\projetos\\loja",
}

describe("lessons memory", () => {
  test("saved, listed, found by the error text and removed", async () => {
    const saved = await Lessons.add(hydration)
    expect((await Lessons.list()).map((lesson) => lesson.id)).toEqual([saved.id])

    const found = await Lessons.search("Warning: hydration mismatch no Next.js depois de mudar o header", "C:\\projetos\\outro")
    expect(found[0]?.lesson.id).toBe(saved.id)
    expect(await Lessons.search("deixe o botão azul e maior")).toEqual([])

    await Lessons.used([saved.id])
    expect((await Lessons.list())[0]!.uses).toBe(1)
    expect(await Lessons.remove(saved.id)).toBe(true)
    expect(await Lessons.list()).toEqual([])
  })

  test("the same project ranks first among equal matches", async () => {
    await Lessons.add({ ...hydration, project: "C:\\projetos\\outro" })
    const here = await Lessons.add(hydration)
    const found = await Lessons.search("hydration mismatch react", "C:\\projetos\\loja")
    expect(found[0]?.lesson.id).toBe(here.id)
  })

  test("keys, tokens and passwords are removed before saving", async () => {
    const saved = await Lessons.add({
      problem: "401 from the API with OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx",
      solution: "Set the token: ghp_abcdefghijklmnopqrstuvwxyz0123 and senha: hunter22 in .env, not in code",
    })
    const text = JSON.stringify(saved)
    expect(text).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx")
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123")
    expect(text).not.toContain("hunter22")
  })

  test("a lesson needs a problem and a solution", async () => {
    expect(Lessons.add({ problem: " ", solution: "x" })).rejects.toThrow()
  })

  test("accents and common words do not decide a match", () => {
    expect([...Lessons.words("Não consigo instalar a dependência do Prisma")]).toEqual(
      expect.arrayContaining(["consigo", "instalar", "dependencia", "prisma"]),
    )
    expect(Lessons.words("para com uma que")).toEqual(new Set())
  })
})
