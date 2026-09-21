import { describe, expect, test } from "bun:test"
import { Docx } from "../../src/util/docx"
import { makeDocx, makeZip } from "../fixture/docx"

describe("reading Word documents", () => {
  test("gives the text of each paragraph, one per line", () => {
    const bytes = makeDocx(["Roteiro de Atividade Prática", "1. Crie a tabela <alunos> & insira 3 linhas"])
    expect(Docx.docxText(bytes)).toBe("Roteiro de Atividade Prática\n1. Crie a tabela <alunos> & insira 3 linhas")
  })

  test("is not fooled by something that is not a Word document", () => {
    expect(Docx.docxText(new TextEncoder().encode("%PDF-1.4"))).toBeUndefined()
    expect(Docx.docxText(makeZip({ "readme.txt": "oi" }))).toBeUndefined()
  })
})
