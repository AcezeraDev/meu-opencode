/**
 * A small, safe Markdown renderer for the side panel: paragraphs, headings,
 * lists, code (inline and fenced), bold, italic and http(s) links. Everything
 * is escaped first, so a reply can never inject markup into the panel.
 */
function renderMarkdown(source) {
  const escape = (text) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  const inline = (text) =>
    escape(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')

  const out = []
  const lines = String(source || "").replace(/\r/g, "").split("\n")
  let paragraph = []
  let list
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`)
    paragraph = []
    if (list) out.push(`<${list.kind}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.kind}>`)
    list = undefined
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fence = line.match(/^```/)
    if (fence) {
      flush()
      const code = []
      for (index++; index < lines.length && !/^```/.test(lines[index]); index++) code.push(lines[index])
      out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`)
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      flush()
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`)
      continue
    }
    const item = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/)
    if (item) {
      const kind = item[1] ? "ol" : "ul"
      if (paragraph.length || (list && list.kind !== kind)) flush()
      list = list ?? { kind, items: [] }
      list.items.push(item[2])
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (list) flush()
    paragraph.push(line)
  }
  flush()
  return out.join("")
}
