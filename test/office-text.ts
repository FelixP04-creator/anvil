// Office text extraction test: builds real .docx/.xlsx/.pptx files (ZIP +
// XML) in memory and verifies what web/office-text.js extracts. No API key
// or network needed. Run with: node test/office-text.ts

import { deflateRawSync } from "node:zlib"
import { officeToText } from "../web/office-text.js"

let failures = 0
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`)
  }
}

// ---------------------------------------------------------------- ZIP writer
// Minimal but spec-accurate writer (local header + central directory + EOCD),
// with both stored (0) and deflated (8) entries so both reader paths run.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(files: [string, string | Buffer, 0 | 8][]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content, method] of files) {
    const nameBuf = Buffer.from(name, "utf8")
    const raw = typeof content === "string" ? Buffer.from(content, "utf8") : content
    const comp = method === 8 ? deflateRawSync(raw) : raw
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, comp)

    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0, 8)
    c.writeUInt16LE(method, 10)
    c.writeUInt16LE(0, 12)
    c.writeUInt16LE(0x21, 14)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(comp.length, 20)
    c.writeUInt32LE(raw.length, 24)
    c.writeUInt16LE(nameBuf.length, 28)
    c.writeUInt16LE(0, 30)
    c.writeUInt16LE(0, 32)
    c.writeUInt16LE(0, 34)
    c.writeUInt16LE(0, 36)
    c.writeUInt32LE(0, 38)
    c.writeUInt32LE(offset, 42)
    central.push(c, nameBuf)

    offset += local.length + nameBuf.length + comp.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, centralBuf, eocd])
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n— office text extraction (docx / xlsx / pptx) —")

  const docx = makeZip([
    [
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:r><w:t>Hello Anvil &amp; Friends</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Line 1</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Second paragraph &#228;</w:t></w:r></w:p>' +
        "</w:body></w:document>",
      8, // deflated
    ],
  ])
  const docxOut = await officeToText("report.docx", docx)
  check("docx: paragraphs extracted as lines", docxOut.split("\n").length >= 2, docxOut)
  check("docx: entities decoded", docxOut.includes("Hello Anvil & Friends"), docxOut)
  check("docx: tab preserved", docxOut.includes("Hello Anvil & Friends\tLine 1"), docxOut)
  check("docx: numeric entity decoded", docxOut.includes("Second paragraph ä"), docxOut)

  const xlsx = makeZip([
    [
      "xl/sharedStrings.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">' +
        "<si><t>Name</t></si><si><t>Werte</t></si></sst>",
      8,
    ],
    [
      "xl/worksheets/sheet1.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>42</t></is></c><c r="B2"><v>3.5</v></c><c r="C2"/></row>' +
        "</sheetData></worksheet>",
      0, // stored — exercises the uncompressed reader path
    ],
  ])
  const xlsxOut = await officeToText("data.xlsx", xlsx)
  check("xlsx: sheet header present", xlsxOut.includes("--- Sheet: sheet1.xml ---"), xlsxOut)
  check("xlsx: shared strings resolved", xlsxOut.includes("Name\tWerte"), xlsxOut)
  check("xlsx: inline + numeric cells kept", xlsxOut.includes("42\t3.5"), xlsxOut)

  // slide2 is listed first in the archive on purpose — output must be in
  // numeric slide order.
  const pptx = makeZip([
    [
      "ppt/slides/slide2.xml",
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
        '<a:p><a:r><a:t>Zweite Folie</a:t></a:r></a:p>' +
        "</p:spTree></p:cSld></p:sld>",
      8,
    ],
    [
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
        '<a:p><a:r><a:t>Erste Folie</a:t></a:r></a:p>' +
        "</p:spTree></p:cSld></p:sld>",
      8,
    ],
  ])
  const pptxOut = await officeToText("deck.pptx", pptx)
  check(
    "pptx: slides extracted in numeric order",
    pptxOut.indexOf("--- Slide 1 ---") !== -1 && pptxOut.indexOf("--- Slide 1 ---") < pptxOut.indexOf("--- Slide 2 ---"),
    pptxOut,
  )
  check("pptx: slide text extracted", pptxOut.includes("Erste Folie") && pptxOut.includes("Zweite Folie"), pptxOut)

  // A corrupted archive must throw a readable error, not hang or return "".
  let threw = ""
  try {
    await officeToText("bad.docx", Buffer.from("this is definitely not a zip file, just some stray text bytes!!"))
  } catch (err) {
    threw = String((err as Error).message)
  }
  check("corrupt archive → readable error", /ZIP directory/.test(threw), threw)

  if (failures) {
    console.log(`\n${failures} TEST(S) FAILED`)
    process.exit(1)
  }
  console.log("\nALL OFFICE TESTS PASSED")
}

main()
