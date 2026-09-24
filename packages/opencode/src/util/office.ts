import { Docx } from "./docx"

/**
 * The text of PowerPoint (.pptx) and Excel (.xlsx) files, without an Office
 * library, the way `docx.ts` reads Word: each is a zip of XML.
 *
 * - A slide's text is in `<a:t>` runs of `ppt/slides/slideN.xml`, paragraphs
 *   ending at `</a:p>`, so it reads like a Word body in another namespace.
 * - A sheet's cells are in `xl/worksheets/sheetN.xml`; text cells point into
 *   `xl/sharedStrings.xml`, numbers are written in place. Each row becomes one
 *   line with tabs between columns, so a table reads as a table.
 *
 * Good enough for the model to read a lesson's slides or a spreadsheet of
 * answers; formatting, images, charts and formulas are lost.
 */

/** Slides and sheets beyond these are not read; the file is still there to open. */
const MAX_PARTS = 200
const MAX_ROWS = 500

/** The text of each slide, in order, or undefined when the bytes are not a presentation. */
export function slides(bytes: Uint8Array) {
  if (!Docx.isZip(bytes)) return undefined
  const found = Array.from({ length: MAX_PARTS }, (_, index) =>
    Docx.unzipFile(bytes, `ppt/slides/slide${index + 1}.xml`),
  )
  const count = found.findIndex((part) => part === undefined)
  const parts = count < 0 ? found : found.slice(0, count)
  if (parts.length === 0) return undefined
  return parts.map((part) =>
    Docx.textOfXml(
      part!
        .toString("utf8")
        .replace(/<\/a:p>/g, "</w:p>")
        .replace(/<a:br\/>/g, "<w:br/>"),
    ),
  )
}

/** Each sheet's name and rows, one line per row with tabs between cells, or undefined when not a workbook. */
export function sheets(bytes: Uint8Array) {
  if (!Docx.isZip(bytes)) return undefined
  const workbook = Docx.unzipFile(bytes, "xl/workbook.xml")?.toString("utf8")
  if (!workbook) return undefined
  const names = Array.from(workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g), (match) => decode(match[1]!))
  const shared = Array.from(
    (Docx.unzipFile(bytes, "xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g),
    (match) => runs(match[1]!),
  )
  return names.slice(0, MAX_PARTS).flatMap((name, index) => {
    const xml = Docx.unzipFile(bytes, `xl/worksheets/sheet${index + 1}.xml`)?.toString("utf8")
    if (xml === undefined) return []
    const rows = Array.from(xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g), (match) => row(match[1]!, shared))
      .filter((line) => line.trim())
      .slice(0, MAX_ROWS)
    return [{ name, rows }]
  })
}

/** What the model is given for a presentation or a workbook. */
export function render(input: { url: string; name: string; slides?: string[]; sheets?: { name: string; rows: string[] }[] }) {
  if (input.slides) {
    return [
      `url: ${input.url}`,
      `type: PowerPoint presentation, ${input.slides.length} slide${input.slides.length === 1 ? "" : "s"}`,
      "",
      ...input.slides.map((text, index) => `--- slide ${index + 1} ---\n${text || "(no text on this slide)"}`),
    ].join("\n")
  }
  const sheets = input.sheets ?? []
  return [
    `url: ${input.url}`,
    `type: Excel workbook, ${sheets.length} sheet${sheets.length === 1 ? "" : "s"} (one line per row, cells separated by tabs)`,
    "",
    ...sheets.map((sheet) => `--- sheet "${sheet.name}" ---\n${sheet.rows.join("\n") || "(empty)"}`),
  ].join("\n")
}

function row(xml: string, shared: string[]) {
  const cells = Array.from(xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g), (match) => {
    const attributes = match[1] ?? ""
    const body = match[2] ?? ""
    const column = columnOf(/\br="([A-Z]+)\d+"/.exec(attributes)?.[1])
    const type = /\bt="(\w+)"/.exec(attributes)?.[1]
    const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
    const text =
      type === "s"
        ? (shared[Number(value)] ?? "")
        : type === "inlineStr"
          ? runs(body)
          : type === "b"
            ? value === "1"
              ? "TRUE"
              : "FALSE"
            : decode(value ?? "")
    return { column, text: text.replace(/\s+/g, " ").trim() }
  })
  const width = cells.reduce((most, cell) => Math.max(most, cell.column + 1), 0)
  const line = Array.from({ length: width }, () => "")
  cells.forEach((cell, index) => {
    line[cell.column >= 0 ? cell.column : index] = cell.text
  })
  return line.join("\t").replace(/\t+$/, "")
}

/** A column's index from its letters: A is 0, Z 25, AA 26. */
function columnOf(letters: string | undefined) {
  if (!letters) return -1
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

/** The text of the `<t>` runs in a piece of spreadsheet XML. */
function runs(xml: string) {
  return decode(Array.from(xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g), (match) => match[1]).join(""))
}

function decode(text: string) {
  return Docx.textOfXml(text)
}

export * as Office from "./office"
