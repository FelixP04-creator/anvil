// anvil markdown — tiny, safe, dependency-free markdown renderer.
//
// Isomorphic ESM module: used by the web UI (browser) and the test suite
// (node). Escape first, then transform — the output only ever contains our
// own tags. Supports fenced code blocks, headings, lists, blockquotes, hr,
// links, bold, italic and inline code — everything an agent answer uses.
//
// Code blocks are left open while streaming: the fence regex matches
// until the next ``` OR the end of the text, so an in-flight block already
// renders correctly from the first token.

let cbCounter = 0

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

export function codeBlockHtml({ lang, code }) {
  const id = `cb${++cbCounter}`
  return `<div class="codeblock"><div class="cb-head"><span class="cb-lang">${escapeHtml(lang || "text")}</span><button class="cb-copy" type="button" data-cb="${id}">copy</button></div><pre class="cb-pre" id="${id}"><code>${highlight(code, lang)}</code></pre></div>`
}

export function renderMarkdown(src) {
  const blocks = []
  const text = String(src).replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    blocks.push({ lang: lang || "", code: code.replace(/\n$/, "") })
    return `\u0000CB${blocks.length - 1}\u0000`
  })
  const lines = escapeHtml(text).split("\n")
  let html = ""
  let para = []
  let list = null
  const flushPara = () => {
    if (para.length) {
      html += `<p>${inlineMd(para.join(" "))}</p>`
      para = []
    }
  }
  const flushList = () => {
    if (list) {
      html += `<${list.type}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join("")}</${list.type}>`
      list = null
    }
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "")
    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }
    const cb = line.match(/^\u0000CB(\d+)\u0000$/)
    if (cb) {
      flushPara()
      flushList()
      html += codeBlockHtml(blocks[+cb[1]])
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      flushPara()
      flushList()
      const lvl = h[1].length + 1 // h1 is the page title; demote
      html += `<h${lvl}>${inlineMd(h[2])}</h${lvl}>`
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushPara()
      flushList()
      html += "<hr>"
      continue
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ul) {
      flushPara()
      if (!list || list.type !== "ul") {
        flushList()
        list = { type: "ul", items: [] }
      }
      list.items.push(ul[1])
      continue
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ol) {
      flushPara()
      if (!list || list.type !== "ol") {
        flushList()
        list = { type: "ol", items: [] }
      }
      list.items.push(ol[1])
      continue
    }
    const bq = line.match(/^&gt;\s?(.*)$/)
    if (bq) {
      flushPara()
      flushList()
      html += `<blockquote>${inlineMd(bq[1])}</blockquote>`
      continue
    }
    para.push(line)
  }
  flushPara()
  flushList()
  return html
}

// ---------------------------------------------------------------- highlighting

const KEYWORDS = {
  js: "const|let|var|function|return|if|else|for|while|do|import|from|export|default|new|class|extends|super|implements|interface|type|enum|await|async|try|catch|finally|throw|switch|case|break|continue|yield|of|in|instanceof|typeof|void|delete|this|static|get|set|null|undefined|true|false",
  bash: "echo|cd|ls|cat|node|npm|npx|pnpm|yarn|bun|deno|git|curl|wget|mkdir|rm|cp|mv|touch|find|grep|sed|awk|sort|head|tail|wc|diff|patch|chmod|chown|sudo|docker|make|test|python|python3|pip|uv|export|source|alias|unset|which|pwd|exit|return|set|local",
  py: "def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|None|True|False|print|in|not|and|or|is",
  json: "true|false|null",
  css: "@media|@keyframes|@import|@font-face|@supports|@layer",
}

function buildRules(lang) {
  const L = String(lang || "").toLowerCase()
  const kw =
    L === "json" ? KEYWORDS.json
    : L.startsWith("sh") || L === "bash" || L === "shell" ? KEYWORDS.bash
    : L.startsWith("py") ? KEYWORDS.py
    : L === "css" || L === "scss" || L === "less" ? KEYWORDS.css
    : KEYWORDS.js
  const str = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`(?:[^\`\\]|\\.)*\``
  const rules = [
    { cls: "tk-c", src: L.startsWith("sh") || L === "bash" || L === "shell" ? String.raw`#[^\n]*` : String.raw`//[^\n]*|/\*[\s\S]*?\*/` },
    { cls: "tk-s", src: str },
    { cls: "tk-n", src: L === "css" ? String.raw`\b\d[\d.]*(?:px|rem|em|vh|vw|vmin|vmax|s|ms|deg|fr|ch|%)?\b` : String.raw`\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b` },
    { cls: "tk-k", src: `(?:\\b(?:${kw})\\b)` },
  ]
  if (!L.startsWith("sh") && L !== "bash" && L !== "shell") {
    rules.push({ cls: "tk-f", src: String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()` })
  }
  return rules
}

export function highlight(code, lang) {
  const rules = buildRules(lang)
  const re = new RegExp(rules.map((r) => `(${r.src})`).join("|"), "g")
  let out = ""
  let last = 0
  let m
  while ((m = re.exec(code)) !== null) {
    out += escapeHtml(code.slice(last, m.index))
    let cls = "tk-k"
    for (let i = 1; i < m.length; i++) {
      if (m[i] !== undefined) {
        cls = rules[i - 1].cls
        break
      }
    }
    out += `<span class="${cls}">${escapeHtml(m[0])}</span>`
    last = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++
  }
  out += escapeHtml(code.slice(last))
  return out
}
