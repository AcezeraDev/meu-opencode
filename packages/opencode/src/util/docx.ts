import { inflateRawSync } from "zlib"

/**
 * The text of a Word document (.docx), without a Word library.
 *
 * A .docx is a zip holding XML; the body is `word/document.xml`. Its text is in
 * `<w:t>` runs, paragraphs end at `</w:p>`, so a paragraph-per-line reading is
 * a few lines of work once the one file is out of the zip. Good enough for the
 * model to read a lesson handout; layout, images and tables' grid are lost.
 */

const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50

/** Whether the bytes are a zip, which every .docx is. */
export function isZip(bytes: Uint8Array) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** One file out of a zip, or undefined when it is not there. */
export function unzipFile(bytes: Uint8Array, name: string): Buffer | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The directory's end record sits in the last 64 KiB (plus its own 22 bytes).
  let end = -1
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65_557); at--) {
    if (data.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at
      break
    }
  }
  if (end < 0) return undefined
  const count = data.readUInt16LE(end + 10)
  let at = data.readUInt32LE(end + 16)
  for (let index = 0; index < count && at + 46 <= data.length; index++) {
    if (data.readUInt32LE(at) !== DIRECTORY_ENTRY) return undefined
    const method = data.readUInt16LE(at + 10)
    const size = data.readUInt32LE(at + 20)
    const nameLength = data.readUInt16LE(at + 28)
    const extraLength = data.readUInt16LE(at + 30)
    const commentLength = data.readUInt16LE(at + 32)
    const local = data.readUInt32LE(at + 42)
    const entry = data.toString("utf8", at + 46, at + 46 + nameLength)
    if (entry === name) {
      if (data.readUInt32LE(local) !== LOCAL_HEADER) return undefined
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
      const raw = data.subarray(start, start + size)
      if (method === 0) return Buffer.from(raw)
      if (method === 8) return inflateRawSync(raw)
      return undefined
    }
    at += 46 + nameLength + extraLength + commentLength
  }
  return undefined
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

/** Paragraphs of a WordprocessingML body, one per line. */
export function textOfXml(xml: string) {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:(br|cr)\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        return Number.isFinite(value) ? String.fromCodePoint(value) : match
      }
      return ENTITIES[code] ?? match
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** The text of a .docx, or undefined when the bytes are not one. */
export function docxText(bytes: Uint8Array) {
  if (!isZip(bytes)) return undefined
  const document = unzipFile(bytes, "word/document.xml")
  return document ? textOfXml(document.toString("utf8")) : undefined
}

export * as Docx from "./docx"
