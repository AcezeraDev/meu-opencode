import { describe, expect, test } from "bun:test"
import { BrowserNotebook } from "../../src/browser/notebook"

describe("study notebook", () => {
  test("keeps explained answers by subject, and ignores steps with nothing to explain", async () => {
    const where = {
      subject: "Modelagem e Desenvolvimento de Banco de Dados – 3º Bimestre",
      place: "Semana 19 (S19) – DDL X DML › Aula 1",
      activity: "Pause e Responda (S19A1a)",
      url: "https://example.com/mod/h5pactivity/view.php?id=1",
    }
    const before = Date.now()
    await BrowserNotebook.add(where, {
      sessionID: "ses_1",
      answer: "CREATE",
      why: "A questão pedia um comando DDL, e CREATE define a estrutura das tabelas.",
    })
    await BrowserNotebook.add(where, { sessionID: "ses_1", answer: "Enviar", why: "   " })
    await BrowserNotebook.add(undefined, { sessionID: "ses_1", answer: "x", why: "sem página" })

    const subjects = await BrowserNotebook.list()
    const subject = subjects.find((item) => item.subject === where.subject)
    expect(subject).toMatchObject({ slug: "modelagem-e-desenvolvimento-de-banco-de-dados-3-bimestre", count: 1 })

    const page = await BrowserNotebook.entries(subject!.slug)
    expect(page?.entries[0]).toMatchObject({
      place: where.place,
      activity: where.activity,
      answer: "CREATE",
      why: "A questão pedia um comando DDL, e CREATE define a estrutura das tabelas.",
    })
    expect(await BrowserNotebook.countSince(before)).toBeGreaterThanOrEqual(1)
    // A name that is not a plain slug never reaches the file system.
    expect(await BrowserNotebook.entries("../auth")).toBeUndefined()
  })
})
