import { describe, expect, test } from "bun:test"
import { Docx } from "@/util/docx"
import { Office } from "@/util/office"
import { makeDocx, makePptx, makeXlsx } from "../fixture/office"

describe("reading Office files", () => {
  test("a Word document reads paragraph by paragraph", () => {
    expect(Docx.docxText(makeDocx(["Aula 3", "Formas normais & dependências"]))).toBe(
      "Aula 3\nFormas normais & dependências",
    )
  })

  test("a presentation reads slide by slide, in order", () => {
    const text = Office.slides(makePptx([["Título da aula", "Objetivos"], ["Exemplo 1"], []]))
    expect(text).toEqual(["Título da aula\nObjetivos", "Exemplo 1", ""])
    const rendered = Office.render({ url: "u", name: "a.pptx", slides: text })
    expect(rendered).toContain("PowerPoint presentation, 3 slides")
    expect(rendered).toContain("--- slide 2 ---\nExemplo 1")
    expect(rendered).toContain("(no text on this slide)")
  })

  test("a workbook reads sheet by sheet, a row per line, with empty cells kept in place", () => {
    const sheets = Office.sheets(
      makeXlsx([
        {
          name: "Notas",
          rows: [
            ["Aluno", "Nota", "Situação"],
            ["Ana", 9.5, "Aprovada"],
            ["Bruno", undefined, "Faltou"],
          ],
        },
        { name: "Vazia", rows: [] },
      ]),
    )
    expect(sheets).toEqual([
      { name: "Notas", rows: ["Aluno\tNota\tSituação", "Ana\t9.5\tAprovada", "Bruno\t\tFaltou"] },
      { name: "Vazia", rows: [] },
    ])
    const rendered = Office.render({ url: "u", name: "a.xlsx", sheets })
    expect(rendered).toContain('--- sheet "Notas" ---')
    expect(rendered).toContain('--- sheet "Vazia" ---\n(empty)')
  })

  test("something that is not a presentation or a workbook is told apart", () => {
    const docx = makeDocx(["só texto"])
    expect(Office.slides(docx)).toBeUndefined()
    expect(Office.sheets(docx)).toBeUndefined()
    expect(Office.slides(new TextEncoder().encode("<html>login</html>"))).toBeUndefined()
  })
})
