// Best-effort PDF text extraction (zero dependencies).
//
// The web UI uses this to turn uploaded PDFs into text for providers that
// cannot read PDF bytes directly (the hsnr gateway, local runtimes). This
// file must stay DOM-free so the Node test suite imports the exact same
// code the browser runs.
//
// Supported: classic xref tables, xref streams (PDF 1.5+), object streams,
// FlateDecode / ASCIIHexDecode streams, literal + hex strings with escapes,
// text objects (BT/ET) with the Tj / ' / " / TJ operators, line breaks via
// Td / TD / T* / Tm, cp1252-ish byte fonts and ToUnicode CMaps (bfchar +
// bfrange) for CID fonts.
//
// Not supported (by design, best effort): encrypted PDFs, text inside form
// XObjects (Do), content without any text operators (scans), CJK fonts
// without a ToUnicode CMap, PNG predictor streams.
//
// pdfToText(buf) -> Promise<string | null>: the extracted text, or null
// when nothing usable could be recovered.

// Byte-faithful decode: one char per byte, charCode === byte value.
// (TextDecoder must not be used for this — runtimes like Node alias
// "latin1"/"iso-8859-1" to windows-1252, which remaps 0x80–0x9F and would
// corrupt both offsets and string bytes.)
function byteString(bytes) {
  let s = ""
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
  }
  return s
}

// Bytes 0x80–0x9F differ from latin-1 (code page 1252); the rest map 1:1.
const CP1252 = {
  0x80: "\u20AC", 0x82: "\u201A", 0x83: "\u0192", 0x84: "\u201E", 0x85: "\u2026",
  0x86: "\u2020", 0x87: "\u2021", 0x88: "\u02C6", 0x89: "\u2030", 0x8A: "\u0160",
  0x8B: "\u2039", 0x8C: "\u0152", 0x8E: "\u017D", 0x91: "\u2018", 0x92: "\u2019",
  0x93: "\u201C", 0x94: "\u201D", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014",
  0x98: "\u02DC", 0x99: "\u2122", 0x9A: "\u0161", 0x9B: "\u203A", 0x9C: "\u0153",
  0x9E: "\u017E", 0x9F: "\u0178",
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Extract readable text from a PDF (ArrayBuffer or Uint8Array). */
export async function pdfToText(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (bytes.length < 16) return null
  if (
    bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 ||
    bytes[3] !== 0x46 || bytes[4] !== 0x2d
  ) {
    return null // not "%PDF-"
  }

  // One char per byte (byte-faithful), so string indexes ARE byte offsets.
  const text = byteString(bytes)
  const objects = new Map() // objNum -> { offset } | { objstm, idx }
  const cache = new Map() // objNum -> parsed object

  // ---------------------------------------------------------------- objects

  function parseObjAt(offset) {
    const m = /^\s*(\d+)\s+\d+\s+obj\b/.exec(text.slice(offset, offset + 80))
    if (!m) return null
    const num = +m[1]
    const i = offset + m[0].length
    const sPos = text.indexOf("stream", i)
    const ePos = text.indexOf("endobj", i)
    if (sPos !== -1 && (ePos === -1 || sPos < ePos)) {
      const dict = text.slice(i, sPos)
      let dStart = sPos + 6
      if (text[dStart] === "\r") dStart++
      if (text[dStart] === "\n") dStart++
      let length = null
      const lm = /\/Length\s+(\d+)/.exec(dict)
      if (lm) length = +lm[1]
      else {
        // Indirect length: "N G obj <int> endobj" at the recorded offset.
        const lr = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict)
        const loc = lr ? objects.get(+lr[1]) : null
        const om = loc && loc.offset !== undefined
          ? /^\s*\d+\s+\d+\s+obj\s*(\d+)/.exec(text.slice(loc.offset, loc.offset + 100))
          : null
        if (om) length = +om[1]
      }
      if (length === null || dStart + length > bytes.length) return { num, dict, raw: null }
      return { num, dict, raw: bytes.subarray(dStart, dStart + length) }
    }
    const end = ePos !== -1 ? ePos : text.length
    return { num, dict: text.slice(i, end), raw: null }
  }

  async function decodeStream(dict, data) {
    let d = data
    const fm = /\/Filter\s*(\/[A-Za-z0-9_]+|\[[^\]]*\])/.exec(dict)
    if (!fm) return d
    const filters = fm[1].startsWith("[")
      ? fm[1].slice(1, -1).match(/\/[A-Za-z0-9_]+/g) ?? []
      : [fm[1]]
    if (filters.some((f) => f !== "/FlateDecode" && f !== "/ASCIIHexDecode")) return null
    for (const f of filters) {
      if (f === "/FlateDecode") {
        try {
          d = await inflate(d)
        } catch {
          return null
        }
      } else {
        let hex = ""
        for (const x of d) {
          const c = String.fromCharCode(x)
          if ("0123456789abcdefABCDEF".includes(c)) hex += c
        }
        const out = new Uint8Array(hex.length >> 1)
        for (let i = 0; i + 1 < hex.length; i += 2) out[i >> 1] = parseInt(hex.slice(i, i + 2), 16)
        d = out
      }
    }
    return d
  }

  async function getObj(num) {
    if (num === null || num === undefined || !Number.isFinite(num)) return null
    if (cache.has(num)) return cache.get(num)
    const loc = objects.get(num)
    if (!loc) return null
    let obj = null
    if (loc.offset !== undefined) {
      obj = parseObjAt(loc.offset)
    } else {
      // Type-2 entry: the object lives inside an object stream.
      const host = await getObj(loc.objstm)
      if (host && host.raw) {
        const data = await decodeStream(host.dict, host.raw)
        if (data) {
          const body = byteString(data)
          const nm = /\/N\s+(\d+)/.exec(host.dict)
          const fm = /\/First\s+(\d+)/.exec(host.dict)
          if (nm && fm) {
            const first = +fm[1]
            const head = body.slice(0, Math.min(first, body.length))
            const pairs = head.trim().split(/\s+/).map(Number)
            for (let p = 0; p + 1 < pairs.length; p += 2) {
              if (pairs[p] === num) {
                const start = first + pairs[p + 1]
                const end = p + 2 < pairs.length ? first + pairs[p + 3] : body.length
                obj = { num, dict: body.slice(start, end), raw: null }
                break
              }
            }
          }
        }
      }
    }
    if (obj) cache.set(num, obj)
    return obj
  }

  // -------------------------------------------------------------------- xref

  function parseXrefTable(at) {
    const head = /^\s*xref/.exec(text.slice(at, at + 32))
    if (!head) return null
    let i = at + head[0].length
    for (;;) {
      const hm = /^\s*(\d+)\s+(\d+)(?=\s|$)/.exec(text.slice(i, i + 40))
      if (!hm) break
      const start = +hm[1]
      const count = +hm[2]
      i += hm[0].length
      // The header line ends with a newline before the fixed-width entries.
      while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\r")) i++
      if (i + count * 20 > text.length) return null
      for (let n = 0; n < count; n++) {
        const m = /^(\d{10})\s+(\d{5})\s+([nf])/.exec(text.slice(i, i + 20))
        if (!m) return null
        i += 20
        if (m[3] === "n") {
          const num = start + n
          if (!objects.has(num)) objects.set(num, { offset: +m[1] })
        }
      }
    }
    const end = text.indexOf("startxref", i)
    const region = text.slice(i, end === -1 ? Math.min(i + 4000, text.length) : end)
    const rm = /\/Root\s+(\d+)\s+\d+\s+R/.exec(region)
    const pm = /\/Prev\s+(\d+)/.exec(region)
    return { root: rm ? +rm[1] : null, prev: pm ? +pm[1] : null }
  }

  async function parseXrefStream(at) {
    const obj = parseObjAt(at)
    if (!obj || !obj.raw) return null
    const dict = obj.dict
    const wm = /\/W\s*\[([^\]]*)\]/.exec(dict)
    if (!wm) return null
    const w = wm[1].trim().split(/\s+/).map(Number)
    if (w.length !== 3 || w.some((x) => !Number.isInteger(x) || x < 0)) return null
    const sizeM = /\/Size\s+(\d+)/.exec(dict)
    const size = sizeM ? +sizeM[1] : 0
    const indexM = /\/Index\s*\[([^\]]*)\]/.exec(dict)
    const index = indexM ? indexM[1].trim().split(/\s+/).map(Number) : [0, size]
    const rm = /\/Root\s+(\d+)\s+\d+\s+R/.exec(dict)
    const pm = /\/Prev\s+(\d+)/.exec(dict)
    const data = await decodeStream(dict, obj.raw)
    if (!data) return { root: rm ? +rm[1] : null, prev: pm ? +pm[1] : null }
    const es = w[0] + w[1] + w[2]
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const readInt = (pos, width) => {
      let v = 0
      for (let k = 0; k < width; k++) v = v * 256 + dv.getUint8(pos + k)
      return v
    }
    let k = 0
    for (let pair = 0; pair + 1 < index.length; pair += 2) {
      const start = index[pair]
      const count = index[pair + 1]
      for (let n = 0; n < count; n++, k++) {
        const pos = k * es
        if (pos + es > data.length) break
        const type = w[0] === 0 ? 1 : readInt(pos, w[0])
        const f2 = readInt(pos + w[0], w[1])
        const f3 = w[2] ? readInt(pos + w[0] + w[1], w[2]) : 0
        if (type === 1 && !objects.has(start + n)) objects.set(start + n, { offset: f2 })
        else if (type === 2 && f2 > 0 && !objects.has(start + n))
          objects.set(start + n, { objstm: f2, idx: f3 })
      }
    }
    return { root: rm ? +rm[1] : null, prev: pm ? +pm[1] : null }
  }

  // -------------------------------------------------------------------- cmap

  function hexToUtf16(hex) {
    // Destination codes are 2-byte big-endian UTF-16 units.
    let s = ""
    for (let i = 0; i + 4 <= hex.length; i += 4)
      s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    return s
  }

  function parseCMap(src) {
    const map1 = new Map()
    const map2 = new Map()
    const add = (srcHex, dstHex) => {
      const chars = hexToUtf16(dstHex)
      if (!chars) return
      const key = parseInt(srcHex, 16)
      if (srcHex.length === 2) map1.set(key, chars)
      else if (srcHex.length === 4) map2.set(key, chars)
    }
    for (const sec of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) add(p[1], p[2])
    }
    for (const sec of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g)) {
        const lo = parseInt(p[1], 16)
        const hi = parseInt(p[2], 16)
        const width = p[1].length
        if (hi - lo < 0 || hi - lo > 4096) continue // keep it bounded
        if (p[4] !== undefined) {
          const base = parseInt(p[4], 16)
          const dstWidth = p[4].length
          for (let c = lo; c <= hi; c++) {
            add(c.toString(16).padStart(width, "0"), (base + (c - lo)).toString(16).padStart(dstWidth, "0"))
          }
        } else if (p[5] !== undefined) {
          const dsts = [...p[5].matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1])
          for (let i = 0; i < dsts.length && lo + i <= hi; i++) {
            add((lo + i).toString(16).padStart(width, "0"), dsts[i])
          }
        }
      }
    }
    if (!map1.size && !map2.size) return null
    return { map1, map2 }
  }

  // ------------------------------------------------------------------ fonts

  async function fontDecoderFor(num) {
    const obj = await getObj(num)
    if (!obj) return null
    let d = obj.dict
    if (/\/Subtype\s*\/Type0/.test(d)) {
      const dm = /\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/.exec(d)
      if (dm) {
        const desc = await getObj(+dm[1])
        if (desc) d += "\n" + desc.dict
      }
    }
    const tm = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(d)
    if (tm) {
      const c = await getObj(+tm[1])
      if (c && c.raw) {
        const data = await decodeStream(c.dict, c.raw)
        if (data) {
          const cmap = parseCMap(byteString(data))
          if (cmap) return { kind: "cmap", cmap }
        }
      }
    }
    if (/\/Subtype\s*\/Type0/.test(d)) return null // CID without a CMap
    return { kind: "cp1252" }
  }

  function decodeFontBytes(font, bytes) {
    if (!font) return ""
    if (font.kind === "cmap") {
      const { map1, map2 } = font.cmap
      let s = ""
      for (let i = 0; i < bytes.length; i++) {
        if (map2.size && i + 1 < bytes.length) {
          const k2 = (bytes[i] << 8) | bytes[i + 1]
          if (map2.has(k2)) {
            s += map2.get(k2)
            i++
            continue
          }
        }
        const k1 = bytes[i]
        if (map1.has(k1)) s += map1.get(k1)
        else if (k1 >= 0x20) s += String.fromCharCode(k1)
      }
      return s
    }
    let s = ""
    for (let i = 0; i < bytes.length; i++) s += CP1252[bytes[i]] ?? String.fromCharCode(bytes[i])
    return s
  }

  async function fontMapFor(page) {
    // Innermost resource dict wins: the page itself, then its ancestors.
    const map = new Map()
    const order = [page.obj, ...page.chain.slice().reverse()]
    for (const o of order) {
      let src = null
      const rm = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(o.dict)
      if (rm) {
        const ro = await getObj(+rm[1])
        if (ro) src = ro.dict
      } else if (/\/Resources/.test(o.dict)) {
        src = o.dict
      }
      if (!src) continue
      let fontSrc = null
      const fr = /\/Font\s+(\d+)\s+\d+\s+R/.exec(src)
      if (fr) {
        const fo = await getObj(+fr[1])
        if (fo) fontSrc = fo.dict
      } else {
        const fm = /\/Font\s*<<(.*?)>>/s.exec(src)
        if (fm) fontSrc = fm[1]
      }
      if (!fontSrc) continue
      for (const e of fontSrc.matchAll(/\/([A-Za-z0-9_+\-]+)\s+(\d+)\s+\d+\s+R/g)) {
        if (map.has(e[1])) continue
        map.set(e[1], await fontDecoderFor(+e[2]))
      }
    }
    return map
  }

  // ------------------------------------------------------------- content

  function tokenize(src) {
    const n = src.length
    let pos = 0
    function skipWs() {
      while (pos < n) {
        const c = src[pos]
        if (c === "%") {
          while (pos < n && src[pos] !== "\n") pos++
          continue
        }
        if (c <= " " || c === "\r") pos++
        else break
      }
    }
    function parseValue() {
      skipWs()
      if (pos >= n) return null
      const c = src[pos]
      if (c === "(") {
        // Literal string with escapes and nested parentheses.
        const arr = []
        pos++
        let depth = 1
        while (pos < n && depth > 0) {
          const ch = src[pos]
          if (ch === "\\") {
            const e = src[pos + 1]
            pos += 2
            if (e === "n") arr.push(10)
            else if (e === "r") arr.push(13)
            else if (e === "t") arr.push(9)
            else if (e === "b") arr.push(8)
            else if (e === "f") arr.push(12)
            else if (e === "(") arr.push(40)
            else if (e === ")") arr.push(41)
            else if (e === "\\") arr.push(92)
            else if (e !== undefined && e >= "0" && e <= "7") {
              let oct = e
              while (oct.length < 3 && pos < n && src[pos] >= "0" && src[pos] <= "7") {
                oct += src[pos]
                pos++
              }
              arr.push(parseInt(oct, 8) & 0xff)
            } else if (e === "\r") {
              if (pos < n && src[pos] === "\n") pos++
            } else if (e !== "\n" && e !== undefined) {
              arr.push(e.charCodeAt(0) & 0xff)
            }
            continue
          }
          if (ch === "(") {
            depth++
            arr.push(40)
          } else if (ch === ")") {
            depth--
            if (depth > 0) arr.push(41)
          } else {
            arr.push(ch.charCodeAt(0) & 0xff)
          }
          pos++
        }
        return { t: "str", v: Uint8Array.from(arr) }
      }
      if (c === "<") {
        if (src[pos + 1] === "<") {
          pos += 2
          return { t: "dict" }
        }
        let hex = ""
        pos++
        while (pos < n && src[pos] !== ">") {
          if (!(src[pos] <= " " || src[pos] === "\r")) hex += src[pos]
          pos++
        }
        pos++
        const out = new Uint8Array(hex.length >> 1)
        for (let i = 0; i + 1 < hex.length; i += 2) out[i >> 1] = parseInt(hex.slice(i, i + 2), 16)
        return { t: "str", v: out }
      }
      if (c === "[") {
        pos++
        const items = []
        for (;;) {
          const v = parseValue()
          if (v === null || v.t === "arrend") break
          items.push(v)
        }
        return { t: "arr", v: items }
      }
      if (c === "]") {
        pos++
        return { t: "arrend" }
      }
      if (c === ">") {
        pos++
        return { t: "dictend" }
      }
      if (c === "/") {
        pos++
        let name = ""
        while (pos < n && src[pos] > " " && !/[\s\[\]<>()/%]/.test(src[pos])) {
          name += src[pos]
          pos++
        }
        return { t: "name", v: name }
      }
      let word = ""
      while (pos < n && src[pos] > " " && !/[\s\[\]<>()/%]/.test(src[pos])) {
        word += src[pos]
        pos++
      }
      if (word === "") {
        pos++
        return parseValue()
      }
      if (/^-?\d*\.?\d+$/.test(word)) return { t: "num", v: Number(word) }
      return { t: "kw", v: word }
    }
    const toks = []
    for (;;) {
      const v = parseValue()
      if (v === null) break
      toks.push(v)
    }
    return toks
  }

  function runContent(toks, fonts) {
    let out = ""
    let inText = false
    let font = null
    const flushLine = () => {
      if (inText && out.length && !out.endsWith("\n")) out += "\n"
    }
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i]
      if (tk.t !== "kw") continue
      const op = tk.v
      if (op === "BT") {
        inText = true
        continue
      }
      if (op === "ET") {
        flushLine()
        inText = false
        continue
      }
      if (!inText) continue
      if (op === "Tf") {
        const nameTok = toks[i - 2] // "/F1 12 Tf": name, size, op
        font = nameTok && nameTok.t === "name" ? (fonts.get(nameTok.v) ?? null) : null
        continue
      }
      if (op === "Tj" || op === "'" || op === '"') {
        if (op !== "Tj") flushLine() // ' and " move to the next line first
        const s = toks[i - 1]
        if (s && s.t === "str") out += decodeFontBytes(font, s.v)
        continue
      }
      if (op === "TJ") {
        const a = toks[i - 1]
        if (a && a.t === "arr") {
          for (const it of a.v) {
            if (it.t === "str") out += decodeFontBytes(font, it.v)
            else if (it.t === "num" && it.v < -150) out += " " // large negative = word gap
          }
        } else if (a && a.t === "str") {
          out += decodeFontBytes(font, a.v) // lenient: bare string operand
        }
        continue
      }
      if (op === "T*" || op === "Tm") {
        flushLine()
        continue
      }
      if (op === "Td" || op === "TD") {
        const dy = toks[i - 1]
        if (dy && dy.t === "num" && dy.v !== 0) flushLine()
        continue
      }
      // Tc, Tw, Tz, TL, Tr, Ts and friends: not needed for text output.
    }
    return out
  }

  // ------------------------------------------------------------------ main

  let startOffset = null
  {
    let from = 0
    let last = -1
    for (;;) {
      const p = text.indexOf("startxref", from)
      if (p === -1) break
      last = p
      from = p + 9
    }
    if (last !== -1) {
      const m = /^\s*(\d+)/.exec(text.slice(last + 9, last + 60))
      if (m) startOffset = +m[1]
    }
  }
  if (startOffset === null || startOffset <= 0 || startOffset >= text.length) return null

  // Walk the xref chain (newest first), collecting the object index and the
  // catalog reference from the first trailer/xref stream that carries it.
  let root = null
  let at = startOffset
  const seen = new Set()
  for (let guard = 0; guard < 32 && at > 0 && at < text.length && !seen.has(at); guard++) {
    seen.add(at)
    if (/^\s*xref/.test(text.slice(at, at + 32))) {
      const r = parseXrefTable(at)
      if (!r) break
      if (root === null) root = r.root
      at = r.prev
    } else {
      const r = await parseXrefStream(at)
      if (!r) break
      if (root === null) root = r.root
      at = r.prev
    }
  }
  if (root === null || !objects.size) return null

  // Page tree walk (document order), keeping the ancestor chain for
  // resource (font) inheritance.
  const rootObj = await getObj(root)
  if (!rootObj) return null
  const pages = []
  async function walkPages(num, chain) {
    const obj = await getObj(num)
    if (!obj) return
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(obj.dict)
    if (kids) {
      for (const ref of kids[1].matchAll(/\d+\s+\d+\s+R/g)) {
        await walkPages(+ref[0].split(/\s+/)[0], [...chain, obj])
      }
    } else if (/\/Type\s*\/Page(?![A-Za-z0-9])/.test(obj.dict)) {
      pages.push({ obj, chain })
    }
  }
  const pagesRef = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(rootObj.dict)
  if (pagesRef) await walkPages(+pagesRef[1], [])
  else {
    const pageRef = /\/Page\s+(\d+)\s+\d+\s+R/.exec(rootObj.dict)
    if (pageRef) {
      const o = await getObj(+pageRef[1])
      if (o) pages.push({ obj: o, chain: [] })
    }
  }
  if (!pages.length) return null

  const parts = []
  for (const page of pages) {
    const fonts = await fontMapFor(page)
    const cm = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(page.obj.dict)
    const ca = /\/Contents\s*\[([^\]]*)\]/.exec(page.obj.dict)
    const refs = cm
      ? [+cm[1]]
      : ca
        ? [...ca[1].matchAll(/\d+\s+\d+\s+R/g)].map((r) => +r[0].split(/\s+/)[0])
        : []
    let streamText = ""
    for (const r of refs) {
      const o = await getObj(r)
      if (!o || !o.raw) continue
      const data = await decodeStream(o.dict, o.raw)
      if (!data || !data.length) continue
      streamText += runContent(tokenize(byteString(data)), fonts)
    }
    const clean = streamText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    if (clean) parts.push(clean)
  }
  const full = parts.join("\n\n").trim()
  // A few stray characters are not trustworthy content; require at least a
  // short line of text before callers may rely on the extraction.
  return full.length >= 4 ? full : null
}
