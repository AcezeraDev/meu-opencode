/**
 * Minimal but valid Word, PowerPoint and Excel files, built by hand so tests
 * need no binary fixtures: a zip with its entries stored uncompressed, holding
 * only the parts the readers look at.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function makeZip(files: Record<string, string>) {
  const locals: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8")
    const data = Buffer.from(text, "utf8")
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    directory.push(entry, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const size = directory.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, ...directory, end]))
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function makeDocx(paragraphs: string[]) {
  return makeZip({
    "word/document.xml": `<w:document><w:body>${paragraphs
      .map((text) => `<w:p><w:r><w:t>${escape(text)}</w:t></w:r></w:p>`)
      .join("")}</w:body></w:document>`,
  })
}

export function makePptx(slides: string[][]) {
  return makeZip(
    Object.fromEntries(
      slides.map((paragraphs, index) => [
        `ppt/slides/slide${index + 1}.xml`,
        `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs
          .map((text) => `<a:p><a:r><a:t>${escape(text)}</a:t></a:r></a:p>`)
          .join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      ]),
    ),
  )
}

/** Sheets of rows; text goes through the shared strings, numbers are written in place. */
export function makeXlsx(sheets: { name: string; rows: (string | number | undefined)[][] }[]) {
  const shared: string[] = []
  const index = (text: string) => {
    const found = shared.indexOf(text)
    if (found >= 0) return found
    shared.push(text)
    return shared.length - 1
  }
  const column = (n: number) => (n >= 26 ? String.fromCharCode(64 + Math.floor(n / 26)) : "") + String.fromCharCode(65 + (n % 26))
  const parts = Object.fromEntries(
    sheets.map((sheet, sheetIndex) => [
      `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      `<worksheet><sheetData>${sheet.rows
        .map(
          (row, rowIndex) =>
            `<row r="${rowIndex + 1}">${row
              .map((cell, cellIndex) => {
                const ref = `${column(cellIndex)}${rowIndex + 1}`
                if (cell === undefined) return ""
                if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`
                return `<c r="${ref}" t="s"><v>${index(cell)}</v></c>`
              })
              .join("")}</row>`,
        )
        .join("")}</sheetData></worksheet>`,
    ]),
  )
  return makeZip({
    "xl/workbook.xml": `<workbook><sheets>${sheets
      .map((sheet, sheetIndex) => `<sheet name="${escape(sheet.name)}" sheetId="${sheetIndex + 1}"/>`)
      .join("")}</sheets></workbook>`,
    "xl/sharedStrings.xml": `<sst>${shared.map((text) => `<si><t>${escape(text)}</t></si>`).join("")}</sst>`,
    ...parts,
  })
}
