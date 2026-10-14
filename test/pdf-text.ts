// PDF text extraction test: builds real PDF files in memory (classic xref
// table, xref streams, object streams, FlateDecode streams, ToUnicode
// CMaps) and verifies what web/pdf-text.js extracts. No API key or network
// needed. Run with: node test/pdf-text.ts

import { deflateSync } from "node:zlib"
import { pdfToText } from "../web/pdf-text.js"

let failures = 0
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`)
  }
}

// ---------------------------------------------------------------- PDF writers
// Minimal but spec-accurate single-file PDF builders. objects[i] becomes
// object i+1; make object 1 the catalog. Stream objects carry `data`
// (optionally Flate-compressed via `filter: true`); `inStm` (xref-stream
// builder only) moves a dict object into an object stream.

const enc = new TextEncoder()

type TestObj = { body: string; data?: Uint8Array; filter?: boolean; inStm?: boolean }

class Writer {
  parts: number[] = []
  write(s: string | Uint8Array): void {
    const b = typeof s === "string" ? enc.encode(s) : s
    for (const x of b) this.parts.push(x)
  }
  get pos(): number {
    return this.parts.length
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

function writeTopLevel(w: Writer, objects: TestObj[], i: number): void {
  const o = objects[i]
  w.write(`${i + 1} 0 obj\n<<`)
  w.write(o.body)
  if (o.data) {
    w.write(` /Length ${o.data.length}${o.filter ? " /Filter /FlateDecode" : ""} >>\nstream\n`)
    w.write(o.data)
    w.write("\nendstream\nendobj\n")
  } else {
    w.write(">>\nendobj\n")
  }
}

function classicPdf(objects: TestObj[], rootObj = 1): Uint8Array {
  const w = new Writer()
  w.write("%PDF-1.4\n")
  const offsets: number[] = []
  objects.forEach((_, i) => {
    offsets.push(w.pos)
    writeTopLevel(w, objects, i)
  })
  const xrefPos = w.pos
  w.write(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
  for (const off of offsets) w.write(`${String(off).padStart(10, "0")} 00000 n \n`)
  w.write(`trailer\n<< /Size ${objects.length + 1} /Root ${rootObj} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`)
  return w.bytes()
}

function xrefStreamPdf(objects: TestObj[], rootObj = 1): Uint8Array {
  const w = new Writer()
  w.write("%PDF-1.4\n")
  const N = objects.length
  const offsets: (number | null)[] = [] // null -> stored in the object stream
  const inStm: { num: number; body: string }[] = []
  objects.forEach((o, i) => {
    if (o.inStm) {
      offsets.push(null)
      inStm.push({ num: i + 1, body: o.body })
    } else {
      offsets.push(w.pos)
      writeTopLevel(w, objects, i)
    }
  })

  // Object stream bundling the dict-only objects (type-2 xref entries).
  let objstmNum = 0
  let objstmOffset = 0
  if (inStm.length) {
    objstmNum = N + 1
    objstmOffset = w.pos
    let s = ""
    for (const o of inStm) s += `${o.num} 0 `
    const first = s.length
    const data = deflateSync(enc.encode(s + inStm.map((o) => o.body).join(" ")))
    w.write(
      `${objstmNum} 0 obj\n<< /Type /ObjStm /N ${inStm.length} /First ${first} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`,
    )
    w.write(data)
    w.write("\nendstream\nendobj\n")
  }

  // The xref stream itself (W [1 4 1]: type 1 byte, offset 4 bytes, f3 1 byte).
  const xrefNum = N + 1 + (inStm.length ? 1 : 0)
  const total = xrefNum + 1 // objects 0..xrefNum
  const xPos = w.pos
  const entries = new Uint8Array(total * 6)
  entries[5] = 0xff // object 0: free, gen 65535
  const setU32 = (b: number, v: number): void => {
    entries[b] = v >>> 24
    entries[b + 1] = (v >>> 16) & 0xff
    entries[b + 2] = (v >>> 8) & 0xff
    entries[b + 3] = v & 0xff
  }
  for (let i = 1; i <= N; i++) {
    const b = i * 6 // entry for object i (object 0's free entry is at byte 0)
    if (offsets[i - 1] === null) {
      entries[b] = 2 // compressed in an object stream
      setU32(b + 1, objstmNum)
      entries[b + 5] = inStm.findIndex((o) => o.num === i)
    } else {
      entries[b] = 1 // uncompressed at offset
      setU32(b + 1, offsets[i - 1] as number)
    }
  }
  if (inStm.length) {
    const b = objstmNum * 6
    entries[b] = 1
    setU32(b + 1, objstmOffset)
  }
  {
    const b = xrefNum * 6
    entries[b] = 1
    setU32(b + 1, xPos)
  }
  const data = deflateSync(entries)
  w.write(
    `${xrefNum} 0 obj\n<< /Type /XRef /Size ${total} /W [1 4 1] /Root ${rootObj} 0 R /Length ${data.length} /Filter /FlateDecode >>\nstream\n`,
  )
  w.write(data)
  w.write("\nendstream\nendobj\n")
  w.write(`startxref\n${xPos}\n%%EOF\n`)
  return w.bytes()
}

// The standard one-page document used by several cases below.
const CONTENT = "BT /F1 18 Tf 72 720 Td (Anvil E2E PDF. The code is PDF-99.) Tj ET"
const baseObjects = (content: Uint8Array, filter = false): TestObj[] => [
  { body: "/Type /Catalog /Pages 2 0 R" },
  { body: "/Type /Pages /Kids [3 0 R] /Count 1" },
  {
    body:
      "/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R",
  },
  { body: "/Type /Font /Subtype /Type1 /BaseFont /Helvetica" },
  { body: "", data: content, filter },
]

console.log("\n— pdf text extraction —")

// 1. Classic xref table, uncompressed content stream.
{
  const text = await pdfToText(classicPdf(baseObjects(enc.encode(CONTENT))))
  check("classic xref, plain stream", text === "Anvil E2E PDF. The code is PDF-99.", `got: ${JSON.stringify(text)}`)
}

// 2. Classic xref table, FlateDecode content stream.
{
  const text = await pdfToText(classicPdf(baseObjects(deflateSync(enc.encode(CONTENT)), true)))
  check("classic xref, FlateDecode stream", text === "Anvil E2E PDF. The code is PDF-99.", `got: ${JSON.stringify(text)}`)
}

// 3. Xref stream (PDF 1.5 style) with a FlateDecode content stream.
{
  const text = await pdfToText(xrefStreamPdf(baseObjects(deflateSync(enc.encode(CONTENT)), true)))
  check("xref stream, FlateDecode", text === "Anvil E2E PDF. The code is PDF-99.", `got: ${JSON.stringify(text)}`)
}

// 4. Xref stream + object stream: the page tree node lives inside an ObjStm.
{
  const objs: TestObj[] = [
    { body: "/Type /Catalog /Pages 2 0 R" },
    { body: "/Type /Pages /Kids [3 0 R] /Count 1", inStm: true },
    {
      body:
        "/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R",
    },
    { body: "/Type /Font /Subtype /Type1 /BaseFont /Helvetica" },
    { body: "", data: enc.encode(CONTENT) },
  ]
  const text = await pdfToText(xrefStreamPdf(objs))
  check("xref stream + object stream", text === "Anvil E2E PDF. The code is PDF-99.", `got: ${JSON.stringify(text)}`)
}

// 5. CID font (Identity-H) with a ToUnicode CMap: 2-byte glyph codes,
//    bfchar + bfrange, TJ arrays, line breaks.
{
  const cmapSrc = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "3 beginbfchar",
    "<0001> <0041>",
    "<0002> <0042>",
    "<0003> <0021>",
    "endbfchar",
    "1 beginbfrange",
    "<0010> <0012> <0043>",
    "endbfrange",
    "endcmap",
    "end",
  ].join("\n")
  const content = "BT /F1 12 Tf 72 720 Td <000100020003> Tj 0 -14 Td [<001000110012>] TJ ET"
  const objs: TestObj[] = [
    { body: "/Type /Catalog /Pages 2 0 R" },
    { body: "/Type /Pages /Kids [3 0 R] /Count 1" },
    {
      body:
        "/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R",
    },
    {
      body:
        "/Type /Font /Subtype /Type0 /BaseFont /T0 /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R",
    },
    { body: "", data: enc.encode(content) },
    {
      body:
        "/Type /Font /Subtype /CIDFontType2 /BaseFont /T0 /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>",
    },
    { body: "", data: deflateSync(enc.encode(cmapSrc)), filter: true },
  ]
  const text = await pdfToText(classicPdf(objs))
  check("ToUnicode CMap (bfchar + bfrange, TJ)", text === "AB!\nCDE", `got: ${JSON.stringify(text)}`)
}

// 6. cp1252 byte font: 0x93/0x94 map to curly quotes.
{
  const content = new Uint8Array([
    ...enc.encode("BT /F1 12 Tf 72 720 Td ("),
    0x93,
    ...enc.encode("quoted"),
    0x94,
    ...enc.encode(") Tj 0 -14 Td (Anvil cp1252 document line two.) Tj ET"),
  ])
  const text = await pdfToText(classicPdf(baseObjects(content)))
  check(
    "cp1252 byte encoding",
    text !== null && text.includes("\u201Cquoted\u201D") && text.includes("Anvil cp1252 document line two."),
    `got: ${JSON.stringify(text)}`,
  )
}

// 7. Multi-page document keeps page order and separates pages.
{
  const p1 = "BT /F1 12 Tf 72 720 Td (First page of the anvil pdf.) Tj ET"
  const p2 = "BT /F1 12 Tf 72 720 Td (Second page of the anvil pdf.) Tj ET"
  const objs: TestObj[] = [
    { body: "/Type /Catalog /Pages 2 0 R" },
    { body: "/Type /Pages /Kids [3 0 R 4 0 R] /Count 2" },
    { body: "/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources 7 0 R /Contents 5 0 R" },
    { body: "/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources 7 0 R /Contents 6 0 R" },
    { body: "", data: enc.encode(p1) },
    { body: "", data: enc.encode(p2) },
    { body: "/Font << /F1 8 0 R >>" },
    { body: "/Type /Font /Subtype /Type1 /BaseFont /Helvetica" },
  ]
  const text = await pdfToText(classicPdf(objs))
  check(
    "multi-page order + shared resources",
    text === "First page of the anvil pdf.\n\nSecond page of the anvil pdf.",
    `got: ${JSON.stringify(text)}`,
  )
}

// 8. Degenerate inputs.
{
  check("tiny buffer -> null", (await pdfToText(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))) === null)
  check(
    "non-pdf bytes -> null",
    (await pdfToText(enc.encode("hello world, definitely not a pdf at all"))) === null,
  )
  const objs: TestObj[] = [
    { body: "/Type /Catalog /Pages 2 0 R" },
    { body: "/Type /Pages /Kids [3 0 R] /Count 1" },
    { body: "/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]" }, // no /Contents
  ]
  check("no content stream -> null", (await pdfToText(classicPdf(objs))) === null)
}

if (failures) {
  console.log(`\n${failures} pdf-text check(s) failed`)
  process.exit(1)
}
console.log("pdf-text: all checks passed")
