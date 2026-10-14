// Zero-dependency Office text extraction for the web UI (and the Node test
// suite — this file must stay DOM-free). .docx/.xlsx/.pptx are ZIP archives;
// entries are inflated with DecompressionStream (browser) — Node 18+ exposes
// the same global, which is what the tests rely on.
//
// Usage:  const text = await officeToText("report.docx", await file.arrayBuffer())

async function zipEntries(buf) {
  // Accepts an ArrayBuffer (browser: file.arrayBuffer()) or a
  // Uint8Array/Buffer view (Node tests, subarrays).
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  const min = Math.max(0, bytes.length - 65557)
  for (let i = bytes.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("no ZIP directory found (corrupt file?)")
  const count = dv.getUint16(eocd + 10, true)
  let off = dv.getUint32(eocd + 16, true)
  const out = new Map()
  const dec = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break
    const method = dv.getUint16(off + 10, true)
    const compSize = dv.getUint32(off + 20, true)
    const nameLen = dv.getUint16(off + 28, true)
    const extraLen = dv.getUint16(off + 30, true)
    const commentLen = dv.getUint16(off + 32, true)
    const localOff = dv.getUint32(off + 42, true)
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen))
    off += 46 + nameLen + extraLen + commentLen
    if (name.endsWith("/") || localOff + 30 > bytes.length) continue
    if (dv.getUint32(localOff, true) !== 0x04034b50) continue
    const lNameLen = dv.getUint16(localOff + 26, true)
    const lExtraLen = dv.getUint16(localOff + 28, true)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = bytes.subarray(start, start + compSize)
    if (method === 0) {
      out.set(name, raw)
    } else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
      out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()))
    }
  }
  return out
}

function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/** .docx → plain text (paragraphs kept as lines, tabs/br preserved). */
function docxText(entries) {
  const xml = new TextDecoder().decode(entries.get("word/document.xml") ?? new Uint8Array())
  if (!xml) throw new Error("no document content found")
  const text = decodeXmlEntities(
    xml
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
  return text.replace(/\n{3,}/g, "\n\n").trim()
}

/** .pptx → plain text, one block per slide. */
function pptxText(entries) {
  const dec = new TextDecoder()
  const slides = [...entries.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => +a.match(/slide(\d+)/)[1] - +b.match(/slide(\d+)/)[1])
  if (!slides.length) throw new Error("no slides found")
  return slides
    .map((k) => {
      const xml = dec.decode(entries.get(k))
      const t = decodeXmlEntities(
        xml.replace(/<a:br[^>]*\/>/g, "\n").replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, ""),
      )
      return `--- Slide ${k.match(/slide(\d+)/)[1]} ---\n${t.replace(/\n{3,}/g, "\n\n").trim()}`
    })
    .join("\n\n")
}

/** .xlsx → tab-separated rows per sheet (shared strings resolved). */
function xlsxText(entries) {
  const dec = new TextDecoder()
  const shared = []
  const ss = entries.get("xl/sharedStrings.xml")
  if (ss) {
    const xml = dec.decode(ss)
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g))
      shared.push(decodeXmlEntities(m[1].replace(/<[^>]+>/g, "")))
  }
  const sheets = [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => +a.match(/sheet(\d+)/)[1] - +b.match(/sheet(\d+)/)[1])
  if (!sheets.length) throw new Error("no worksheets found")
  const parts = sheets.map((sn) => {
    const xml = dec.decode(entries.get(sn))
    const lines = []
    for (const rowM of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = []
      for (const cM of rowM[1].matchAll(/<c\s[^>]*>([\s\S]*?)<\/c>|<c\s[^>]*\/>/g)) {
        const isSelfClosing = cM[1] === undefined
        const attrs = isSelfClosing ? "" : (cM[0].match(/^<c\s([^>]*)>/) || ["", ""])[1]
        const inner = isSelfClosing ? "" : cM[1]
        const vM = inner.match(/<v>([\s\S]*?)<\/v>/)
        const tM = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)
        if (/t="s"/.test(attrs) && vM) cells.push(shared[+vM[1]] ?? "")
        else if (vM) cells.push(vM[1])
        else if (tM) cells.push(decodeXmlEntities(tM[1]))
        else cells.push("")
      }
      if (cells.length) lines.push(cells.join("\t"))
    }
    return `--- Sheet: ${sn.replace(/^xl\/worksheets\//, "")} ---\n${lines.join("\n")}`
  })
  return parts.join("\n\n")
}

/** Extract text from an Office file (by extension) from its raw bytes. */
export async function officeToText(fileName, buf) {
  const name = String(fileName).toLowerCase()
  const entries = await zipEntries(buf)
  if (name.endsWith(".docx")) return docxText(entries)
  if (name.endsWith(".pptx")) return pptxText(entries)
  if (name.endsWith(".xlsx")) return xlsxText(entries)
  throw new Error(`unsupported office format: ${fileName}`)
}

export { zipEntries, decodeXmlEntities, docxText, pptxText, xlsxText }
