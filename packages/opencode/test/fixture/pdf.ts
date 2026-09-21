/**
 * A minimal but valid PDF with one line of text per page, built by hand so
 * tests need no binary fixtures. Text must be plain ASCII without parentheses.
 */
export function makePdf(pages: string[]) {
  const objects: string[] = []
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")
  const font = 3 + pages.length * 2
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`)
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  pages.forEach((text, index) => {
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    )
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`)
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, "latin1"))
}
