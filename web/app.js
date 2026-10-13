// anvil web UI — vanilla JS, zero dependencies.
//
// Performance model (learned from watching other agent UIs melt on long
// sessions): streaming deltas are appended to ONE text node, batched per
// animation frame. Markdown parsing and syntax highlighting run exactly
// once, when a message completes. The DOM only ever grows — nothing is
// re-rendered per token.

const $ = (id) => document.getElementById(id)

// ---------------------------------------------------------------- state

let sessionId = null
let source = null
let busy = false
let sseWasDown = false

let streamEl = null // .msg-text element currently receiving deltas
let streamNode = null // the single text node inside it
let streamBuf = ""
let raf = 0
let pinned = true // auto-scroll only while the user is near the bottom

let thinkWrap = null // .msg.thinking element currently receiving deltas
let thinkEl = null // its .think-body element
let thinkNode = null // the single text node inside the body
let thinkBuf = ""

const openTools = new Map() // toolName -> queue of in-flight chip elements
const renderedPerms = new Set() // permission ids already on screen
const permCards = new Map() // permId -> { card, decided }

let cbCounter = 0

// ---------------------------------------------------------------- helpers

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function fmtTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n)
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function toast(msg, kind = "info") {
  const t = el("div", `toast ${kind}`, msg)
  $("toasts").appendChild(t)
  setTimeout(() => t.classList.add("out"), 3400)
  setTimeout(() => t.remove(), 3900)
}

// ---------------------------------------------------------------- icons

const ICONS = {
  Read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5h7L18.5 8v13a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M13 2.5V8h5.5"/><path d="M8.5 12.5h7M8.5 16h5"/></svg>',
  Write: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5h7L18.5 8v13a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M13 2.5V8h5.5"/><path d="M12 11.5v6M9 14.5h6"/></svg>',
  Edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.6-1 11-11a1.4 1.4 0 0 0 0-2l-2.6-2.6a1.4 1.4 0 0 0-2 0l-11 11L4 20z"/><path d="M13.5 6.5l4 4"/></svg>',
  Bash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 3-3 3M12.5 15.5H17"/></svg>',
  Glob: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5a1 1 0 0 1 1-1h4.6l2 2.2H20a1 1 0 0 1 1 1v9.3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>',
  Grep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20"/></svg>',
  TodoWrite: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5L5.5 8 8 5"/><path d="M4 12.5L5.5 14 8 11"/><path d="M11.5 7h8M11.5 13h8M11.5 19h8M4 19h.01"/></svg>',
  Task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.3 7l7.2 3.9M8.3 17l7.2-3.9"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5a4 4 0 0 0-5.6 4.9L3.5 16.8a2 2 0 1 0 2.8 2.8l5.4-5.4a4 4 0 0 0 4.9-5.6l-2.6 2.6-2.1-2.1z"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  caret: '<svg class="tool-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5.5l7 6.5-7 6.5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8l7.5 2.8v5.6c0 4.8-3.2 8.6-7.5 10-4.3-1.4-7.5-5.2-7.5-10V5.6z"/><path d="M9.2 12l2 2 3.6-4"/></svg>',
  mark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.8 4.4c.3-.3.8-.4 1.2-.4h12.3c1.6 0 3.1.5 4.3 1.4.5.3.6 1 .2 1.5l-.8 1c-1 1.2-2.4 2-4 2.4v2.1c0 .7-.5 1.2-1.2 1.2h-1.3v2.6c1.7.4 3 1.5 3.6 3.2.2.6-.2 1.2-.9 1.2H5.6c-.7 0-1.1-.6-.9-1.2.6-1.7 1.9-2.8 3.6-3.2v-2.6H7c-.7 0-1.2-.5-1.2-1.2v-2.1c-1.7-.5-3.2-1.6-4.3-3.1-.3-.5-.2-1.2.3-1.8z"/></svg>',
  think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M18.8 14.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/></svg>',
}

// ---------------------------------------------------------------- markdown

// Tiny, safe markdown renderer: escape first, then transform. Supports
// fenced code blocks, headings, lists, blockquotes, hr, links, bold,
// italic and inline code — everything an agent answer actually uses.

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

function codeBlockHtml({ lang, code }) {
  const id = `cb${++cbCounter}`
  return `<div class="codeblock"><div class="cb-head"><span class="cb-lang">${escapeHtml(lang || "text")}</span><button class="cb-copy" type="button" data-cb="${id}">copy</button></div><pre class="cb-pre" id="${id}"><code>${highlight(code, lang)}</code></pre></div>`
}

function renderMarkdown(src) {
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

function highlight(code, lang) {
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

// ---------------------------------------------------------------- messages

function scroller() {
  return $("scroller")
}

function nearBottom() {
  const s = scroller()
  return s.scrollHeight - s.scrollTop - s.clientHeight < 90
}

function scrollBottom() {
  const s = scroller()
  s.scrollTop = s.scrollHeight
}

function updateJump() {
  $("jump").hidden = nearBottom()
}

function append(node) {
  const empty = $("empty")
  if (empty) empty.remove()
  $("messages").appendChild(node)
  if (pinned) scrollBottom()
  updateJump()
  return node
}

function userMsg(text) {
  return append(el("div", "msg user", text))
}

function assistantMsg() {
  const wrap = el("div", "msg assistant")
  const role = el("div", "msg-role")
  role.innerHTML = ICONS.mark
  const roleName = el("span", null, "anvil")
  role.appendChild(roleName)
  const text = el("div", "msg-text")
  wrap.append(role, text)
  append(wrap)
  return text
}

function errorLine(text) {
  append(el("div", "error-line", String(text)))
}

function formatInput(name, input) {
  if (!input) return ""
  if (name === "Bash") return String(input.command ?? "")
  if (name === "TodoWrite") {
    const n = Array.isArray(input.todos) ? input.todos.length : 0
    return `${n} task${n === 1 ? "" : "s"}`
  }
  if (name === "Task") return String(input.description ?? "")
  if (input.file_path !== undefined) {
    const extra = input.limit !== undefined ? ` (first ${input.limit} lines)` : ""
    return `${String(input.file_path)}${extra}`
  }
  if (input.pattern !== undefined) {
    const where = input.path !== undefined ? ` in ${input.path}` : ""
    return `${String(input.pattern)}${where}`
  }
  const j = JSON.stringify(input)
  return j.length > 140 ? j.slice(0, 140) + "…" : j
}

function buildTool(name, argsText, state, outputText) {
  const chip = el("div", `tool ${state === "run" ? "" : state}`.trim())
  const head = el("div", "tool-head")

  const ic = el("span", "tool-ic")
  ic.innerHTML = ICONS[name] ?? ICONS.tool
  const nameEl = el("span", "tool-name", name)
  const argsEl = el("span", "tool-args", argsText || " ")
  argsEl.title = argsText || ""

  const status = el("span", "tool-status")
  const paintStatus = (st) => {
    status.innerHTML = ""
    if (st === "run") {
      status.append(el("span", "spinner"))
      status.append(el("span", null, "running"))
    } else {
      const ics = el("span")
      ics.innerHTML = st === "ok" ? ICONS.ok : ICONS.err
      ics.style.display = "inline-flex"
      ics.style.width = "13px"
      ics.style.height = "13px"
      status.append(ics)
      status.append(el("span", null, st === "ok" ? "done" : "error"))
    }
    chip.classList.remove("ok", "err")
    if (st === "ok") chip.classList.add("ok")
    if (st === "err") chip.classList.add("err")
  }
  paintStatus(state)

  head.append(ic, nameEl, argsEl, status)

  let out = null
  if (outputText !== null && outputText !== undefined && outputText.trim()) {
    out = el("pre", "tool-output", outputText)
  } else if (state === "run") {
    out = el("pre", "tool-output empty-note", "waiting for output…")
  }
  chip.append(head)
  if (out) {
    head.insertAdjacentHTML("beforeend", ICONS.caret)
    head.addEventListener("click", () => chip.classList.toggle("open"))
    chip.append(out)
    // Small results read at a glance; everything longer stays collapsed
    // to keep long timelines compact. Errors always open.
    if (outputText && outputText.trim() && (state === "err" || autoOpen(outputText))) {
      chip.classList.add("open")
    }
  }
  return chip
}

function autoOpen(text) {
  const t = String(text)
  return t.length <= 500 && t.split("\n").length <= 4
}

function onToolStart(ev) {
  const chip = buildTool(ev.toolName, formatInput(ev.toolName, ev.input), "run", null)
  append(chip)
  const list = openTools.get(ev.toolName) ?? []
  list.push(chip)
  openTools.set(ev.toolName, list)
}

function onToolEnd(ev) {
  const list = openTools.get(ev.toolName) ?? []
  let chip = list.shift()
  if (!chip) {
    // We missed tool_start (page loaded mid-tool): show the result anyway.
    chip = buildTool(ev.toolName, formatInput(ev.toolName, ev.input), ev.ok ? "ok" : "err", null)
    append(chip)
  }
  const status = chip.querySelector(".tool-status")
  status.innerHTML = ""
  const ics = el("span")
  ics.innerHTML = ev.ok ? ICONS.ok : ICONS.err
  ics.style.display = "inline-flex"
  ics.style.width = "13px"
  ics.style.height = "13px"
  status.append(ics, el("span", null, ev.ok ? "done" : "error"))
  chip.classList.remove("ok", "err", "run")
  chip.classList.add(ev.ok ? "ok" : "err")

  const text = String(ev.text ?? "")
  const old = chip.querySelector(".tool-output")
  if (old) old.remove()
  if (text.trim()) {
    const out = el("pre", "tool-output", text.length > 20000 ? text.slice(0, 20000) + "\n… [truncated]" : text)
    chip.append(out)
    if (!chip.querySelector(".tool-caret")) {
      const head = chip.querySelector(".tool-head")
      head.insertAdjacentHTML("beforeend", ICONS.caret)
      head.addEventListener("click", () => chip.classList.toggle("open"))
    }
    if (!ev.ok || autoOpen(text)) chip.classList.add("open")
  }
}

// ---------------------------------------------------------------- permissions

const PERM_LABEL = { once: "Allowed once", always: "Always allowed", deny: "Denied", stopped: "Stopped" }

function onPermission(ev) {
  if (renderedPerms.has(ev.id)) return
  renderedPerms.add(ev.id)

  const card = el("div", "perm")
  const head = el("div", "perm-head")
  head.innerHTML = ICONS.shield
  head.append(el("span", null, "anvil needs permission"))
  const kbd = el("span", "perm-kbd")
  kbd.append(el("kbd", null, "1"), el("kbd", null, "2"), el("kbd", null, "3"))
  head.appendChild(kbd)
  card.appendChild(head)
  card.appendChild(el("div", "perm-tool", ev.detail || ev.toolName))

  let args = null
  if (ev.input && Object.keys(ev.input).length) {
    args = el("pre", "perm-args", JSON.stringify(ev.input, null, 2))
    card.appendChild(args)
  }

  const actions = el("div", "perm-actions")
  const decided = el("div", "perm-decided")
  const options = [
    ["Allow once", "once", "a-once"],
    ["Always allow", "always", "a-always"],
    ["Deny", "deny", "a-deny"],
  ]
  for (const [label, answer, cls] of options) {
    const b = el("button", cls, label)
    b.type = "button"
    b.addEventListener("click", () => answerPerm(ev.id, answer, card, decided))
    actions.appendChild(b)
  }
  card.append(actions, decided)
  append(card)
  permCards.set(ev.id, { card, decided })
}

async function answerPerm(id, answer, card, decided) {
  for (const b of card.querySelectorAll(".perm-actions button")) b.disabled = true
  const res = await fetch(`/api/sessions/${sessionId}/permissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, answer }),
  }).catch(() => null)
  if (!res || !res.ok) {
    for (const b of card.querySelectorAll(".perm-actions button")) b.disabled = false
    toast("Could not answer the permission prompt", "err")
    return
  }
  resolvePermCard(id, answer)
}

function resolvePermCard(id, answer) {
  const rec = permCards.get(id)
  if (!rec || rec.card.classList.contains("decided")) return
  rec.card.classList.add("decided", answer === "once" || answer === "always" ? "ok" : "err")
  rec.decided.textContent = PERM_LABEL[answer] ?? String(answer)
}

// ---------------------------------------------------------------- streaming

function beginStream() {
  streamEl = assistantMsg()
  streamEl.classList.add("streaming")
  streamNode = document.createTextNode("")
  streamEl.appendChild(streamNode)
  streamBuf = ""
}

/** Collapsible thinking block; open while streaming, collapsed after. */
function beginThinking() {
  const wrap = el("div", "msg thinking")
  const head = el("div", "think-head")
  head.innerHTML = ICONS.think
  head.appendChild(el("span", "think-label", "thinking"))
  const body = el("div", "think-body")
  wrap.append(head, body)
  wrap.dataset.open = "true"
  head.addEventListener("click", () => {
    wrap.dataset.open = wrap.dataset.open === "true" ? "false" : "true"
  })
  append(wrap)
  thinkWrap = wrap
  thinkEl = body
  thinkNode = document.createTextNode("")
  body.appendChild(thinkNode)
  thinkBuf = ""
}

/** Static, collapsed thinking block (transcript replay). */
function renderThinking(text) {
  const wrap = el("div", "msg thinking")
  wrap.dataset.open = "false"
  const head = el("div", "think-head")
  head.innerHTML = ICONS.think
  head.appendChild(el("span", "think-label", `thought · ${fmtTokens(String(text).length)} chars`))
  const body = el("div", "think-body", text)
  wrap.append(head, body)
  head.addEventListener("click", () => {
    wrap.dataset.open = wrap.dataset.open === "true" ? "false" : "true"
  })
  append(wrap)
}

function onDelta(text) {
  if (!streamEl) beginStream()
  streamBuf += text
  setStatus("working", "responding…")
  if (!raf) raf = requestAnimationFrame(flushStream)
}

function onThinkingDelta(text) {
  if (!thinkEl) beginThinking()
  thinkBuf += text
  setStatus("working", "thinking…")
  if (!raf) raf = requestAnimationFrame(flushStream)
}

function flushStream() {
  raf = 0
  let changed = false
  if (thinkNode && thinkBuf !== thinkNode.data) {
    thinkNode.data = thinkBuf
    changed = true
  }
  if (streamNode && streamBuf !== streamNode.data) {
    streamNode.data = streamBuf
    changed = true
  }
  if (changed && pinned) scrollBottom()
}

function finalizeThinking() {
  if (!thinkWrap) return
  const label = thinkWrap.querySelector(".think-label")
  if (label) label.textContent = `thought · ${fmtTokens(thinkBuf.length)} chars`
  thinkWrap.dataset.open = "false"
  thinkWrap = null
  thinkEl = null
  thinkNode = null
  thinkBuf = ""
}

function endStream(finalText) {
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
  if (thinkWrap) {
    const body = thinkWrap.querySelector(".think-body")
    if (body) body.textContent = thinkBuf
    finalizeThinking()
  }
  if (!streamEl) return
  const final = finalText !== undefined && finalText !== null ? finalText : streamBuf
  streamEl.classList.remove("streaming")
  streamEl.innerHTML = renderMarkdown(final)
  streamEl = null
  streamNode = null
  streamBuf = ""
  if (pinned) scrollBottom()
  updateJump()
}

// ---------------------------------------------------------------- state

function setStatus(kind, text) {
  const s = $("status")
  s.className = `status ${kind}`
  $("status-text").textContent = text
}

function setBusy(b) {
  busy = b
  $("send").classList.toggle("stop", b)
  $("send").title = b ? "Stop (Esc)" : "Send (Enter)"
  if (b) setStatus("working", "anvil is working…")
  else setStatus("", "idle")
}

function setTokens(usage) {
  const total = (usage?.input ?? 0) + (usage?.output ?? 0)
  $("tokens").textContent = total ? `~${fmtTokens(total)} tokens` : ""
}

function renderTodos(todos) {
  const panel = $("todo-panel")
  const list = $("todo-list")
  list.innerHTML = ""
  if (!todos || todos.length === 0) {
    panel.dataset.empty = "true"
    return
  }
  panel.dataset.empty = "false"
  const done = todos.filter((t) => t.status === "completed").length
  $("todo-count").textContent = `${done}/${todos.length}`
  for (const t of todos) {
    const li = el("li", t.status)
    li.append(el("span", "todo-ic"))
    li.append(el("span", "todo-txt", t.content))
    list.appendChild(li)
  }
}

function setModelPill(s) {
  const m = s.model ?? ""
  $("model").textContent = m
  $("model").title =
    s.thinking && s.thinking !== "off" ? `${m} · thinking: ${s.thinking}` : m
}

function applyState(s) {
  $("session-title").textContent = s.title ?? "New session"
  setModelPill(s)
  $("cwd").textContent = s.cwd ?? ""
  $("cwd").title = s.cwd ?? ""
  $("empty-cwd").textContent = s.cwd ?? ""
  $("mode").value = s.mode ?? "default"
  renderTodos(s.todos)
  setTokens(s.usage)
  if (s.busy) setBusy(true)
}

async function refreshState() {
  if (!sessionId) return
  const res = await fetch(`/api/sessions/${sessionId}`).catch(() => null)
  if (!res || !res.ok) return
  const s = await res.json()
  applyState(s)
  if (!s.busy && busy) setBusy(false)
  if (s.pendingPermission && !renderedPerms.has(s.pendingPermission.id)) {
    onPermission(s.pendingPermission)
  }
}

// ---------------------------------------------------------------- session list

function renderList(list) {
  const nav = $("session-list")
  nav.innerHTML = ""
  if (!list.length) {
    nav.appendChild(el("div", "sess-empty", "No sessions yet"))
    return
  }
  for (const s of list) {
    const item = el("div", "sess")
    if (s.id === sessionId) item.classList.add("active")
    if (s.busy) item.classList.add("busy")
    if (s.needsPermission) item.classList.add("perm")

    item.appendChild(el("span", "sess-dot"))
    item.appendChild(el("div", "sess-title", s.title))
    item.appendChild(el("div", "sess-meta", `${s.turns} turn${s.turns === 1 ? "" : "s"} · ${timeAgo(s.createdAt)}`))

    const del = el("button", "sess-del", "×")
    del.type = "button"
    del.title = "Delete session"
    del.addEventListener("click", (e) => {
      e.stopPropagation()
      deleteSession(s.id)
    })
    item.appendChild(del)

    item.addEventListener("click", () => {
      closeSidebar()
      openSession(s.id)
    })
    nav.appendChild(item)
  }
}

async function refreshList() {
  const res = await fetch("/api/sessions").catch(() => null)
  if (!res || !res.ok) return
  const data = await res.json()
  renderList(data.sessions ?? [])
}

async function deleteSession(id) {
  const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => null)
  if (!res || !res.ok) {
    toast("Could not delete the session", "err")
    return
  }
  toast("Session deleted", "ok")
  if (id === sessionId) {
    sessionId = null
    await newSession()
  }
  refreshList()
}

// ---------------------------------------------------------------- sessions

async function openSession(id) {
  let s = null
  const res = await fetch(`/api/sessions/${id}`).catch(() => null)
  if (res && res.ok) s = await res.json()
  if (!s) {
    toast("Session not found — starting a new one", "err")
    await newSession()
    return
  }

  sessionId = id
  history.replaceState(null, "", `?session=${id}`)

  // Header + state (before touching the conversation).
  $("session-title").textContent = s.title ?? "New session"
  setModelPill(s)
  $("cwd").textContent = s.cwd ?? ""
  $("cwd").title = s.cwd ?? ""
  $("empty-cwd").textContent = s.cwd ?? ""
  $("mode").value = s.mode ?? "default"
  renderTodos(s.todos)
  setTokens(s.usage)

  // Reset the conversation area.
  endStream(undefined)
  $("messages").innerHTML = ""
  openTools.clear()
  renderedPerms.clear()
  permCards.clear()
  pinned = true
  thinkWrap = null
  thinkEl = null
  thinkNode = null
  thinkBuf = ""

  // Replay the transcript, then any pending permission prompt, in that
  // visual order — the SSE snapshot that follows is deduplicated.
  const t = await fetch(`/api/sessions/${id}/transcript`).catch(() => null)
  if (t && t.ok) {
    const data = await t.json()
    renderTranscript(data.entries ?? [])
  }
  if (s.pendingPermission) onPermission(s.pendingPermission)

  if (source) source.close()
  connectSSE()
  setBusy(s.busy)
  refreshList()
  scrollBottom()
  updateJump()
}

function renderTranscript(entries) {
  for (const e of entries) {
    if (e.role === "user") userMsg(e.text)
    else if (e.role === "thinking") renderThinking(e.text)
    else if (e.role === "assistant") {
      const t = assistantMsg()
      t.innerHTML = renderMarkdown(e.text)
    } else if (e.role === "tool") {
      if (e.pending) {
        append(buildTool(e.name, formatInput(e.name, e.args), "run", null))
      } else {
        const chip = buildTool(e.name, formatInput(e.name, e.args), e.ok ? "ok" : "err", e.output)
        append(chip)
      }
    }
  }
}

async function newSession() {
  const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "default" }) }).catch(() => null)
  if (!res || !res.ok) {
    toast("Could not create a session", "err")
    return
  }
  const created = await res.json()
  refreshList()
  await openSession(created.id)
}

// ---------------------------------------------------------------- SSE

function connectSSE() {
  if (source) source.close()
  sseWasDown = false
  source = new EventSource(`/api/sessions/${sessionId}/events`)
  source.onmessage = (e) => {
    try {
      handle(JSON.parse(e.data))
    } catch {
      // ignore malformed frames
    }
  }
  source.addEventListener("error", () => {
    sseWasDown = true
  })
  source.addEventListener("open", async () => {
    // If the stream dropped and came back, events were lost in the gap —
    // rebuild the conversation from the transcript.
    if (!sseWasDown) return
    sseWasDown = false
    await rebuildTranscript()
  })
}

async function rebuildTranscript() {
  if (!sessionId) return
  const id = sessionId
  if (source) source.close()
  endStream(undefined)
  $("messages").innerHTML = ""
  openTools.clear()
  renderedPerms.clear()
  permCards.clear()
  pinned = true
  const [tRes, sRes] = await Promise.all([
    fetch(`/api/sessions/${id}/transcript`).catch(() => null),
    fetch(`/api/sessions/${id}`).catch(() => null),
  ])
  if (tRes && tRes.ok) {
    const data = await tRes.json()
    renderTranscript(data.entries ?? [])
  }
  if (sRes && sRes.ok) {
    const s = await sRes.json()
    applyState(s)
    if (s.pendingPermission) onPermission(s.pendingPermission)
    setBusy(s.busy)
  }
  if (sessionId === id) {
    connectSSE()
    scrollBottom()
  }
}

// ---------------------------------------------------------------- events

function handle(ev) {
  switch (ev.type) {
    case "assistant_delta":
      onDelta(ev.text ?? "")
      break
    case "assistant_text":
      endStream(ev.text)
      break
    case "thinking_delta":
      onThinkingDelta(ev.text ?? "")
      break
    case "retry":
      setStatus("working", ev.text ?? "retrying…")
      break
    case "tool_start":
      onToolStart(ev)
      break
    case "tool_end":
      onToolEnd(ev)
      break
    case "permission_request":
      onPermission(ev)
      break
    case "permission_resolved":
      resolvePermCard(ev.id, ev.answer)
      break
    case "error":
      errorLine(ev.text ?? "unknown error")
      setStatus("error", "error")
      break
    case "aborted":
      setStatus("stopped", "stopped")
      break
    case "todos":
      renderTodos(ev.todos)
      break
    case "mode_changed":
      $("mode").value = ev.mode
      break
    case "session":
      applyState(ev)
      if (!ev.busy && busy) setBusy(false)
      if (ev.pendingPermission && !renderedPerms.has(ev.pendingPermission.id)) {
        onPermission(ev.pendingPermission)
      }
      break
    case "turn_end":
      endStream(undefined)
      setBusy(false)
      setStatus("", "idle")
      refreshState()
      refreshList()
      break
  }
}

// ---------------------------------------------------------------- composer

function grow() {
  const input = $("input")
  input.style.height = "auto"
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`
}

async function sendNow() {
  if (busy || !sessionId) return
  const input = $("input")
  const text = input.value.trim()
  if (!text) return
  input.value = ""
  input.style.height = "auto"
  userMsg(text)
  setBusy(true)
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      errorLine(err.error ?? `request failed (HTTP ${res.status})`)
      setStatus("error", "error")
      setBusy(false)
    }
  } catch (err) {
    errorLine(String(err))
    setStatus("error", "error")
    setBusy(false)
  }
}

async function abortTurn() {
  if (!sessionId) return
  const res = await fetch(`/api/sessions/${sessionId}/abort`, { method: "POST" }).catch(() => null)
  if (!res || !res.ok) {
    toast("Could not stop the turn", "err")
    return
  }
  toast("Turn stopped", "ok")
}

function wireComposer() {
  const input = $("input")
  input.addEventListener("input", grow)
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendNow()
    }
  })
  $("send").addEventListener("click", () => (busy ? abortTurn() : sendNow()))
  $("mode").addEventListener("change", async (e) => {
    if (!sessionId) return
    const res = await fetch(`/api/sessions/${sessionId}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: e.target.value }),
    }).catch(() => null)
    if (!res || !res.ok) {
      e.target.value = "default"
      toast("Could not change the mode", "err")
    }
  })
}

// ---------------------------------------------------------------- chrome

function initialTheme() {
  try {
    const saved = localStorage.getItem("anvil-theme")
    if (saved === "light" || saved === "dark") return saved
  } catch {}
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
}

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t)
  try {
    localStorage.setItem("anvil-theme", t)
  } catch {}
}

function closeSidebar() {
  $("sidebar").classList.remove("open")
  $("backdrop").classList.remove("show")
}

function wireChrome() {
  $("theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme")
    applyTheme(cur === "light" ? "dark" : "light")
  })

  $("new-session").addEventListener("click", () => {
    closeSidebar()
    newSession()
  })

  $("menu-btn").addEventListener("click", () => {
    $("sidebar").classList.add("open")
    $("backdrop").classList.add("show")
  })
  $("backdrop").addEventListener("click", closeSidebar)

  $("copy-link").addEventListener("click", async () => {
    if (!sessionId) return
    const url = `${location.origin}/?session=${sessionId}`
    try {
      await navigator.clipboard.writeText(url)
      toast("Session link copied", "ok")
    } catch {
      toast(url, "info")
    }
  })

  $("settings-btn").addEventListener("click", openSettings)
  $("settings-close").addEventListener("click", closeSettings)
  $("settings-backdrop").addEventListener("click", closeSettings)
  $("set-save").addEventListener("click", saveSettings)
  $("set-provider").addEventListener("change", () => {
    fillModelSuggestions($("set-provider").value)
  })

  $("jump").addEventListener("click", () => {
    pinned = true
    scrollBottom()
    updateJump()
  })

  scroller().addEventListener("scroll", () => {
    pinned = nearBottom()
    updateJump()
  })

  // Code-block copy buttons (delegated — blocks are created dynamically).
  $("messages").addEventListener("click", async (e) => {
    const btn = e.target.closest(".cb-copy")
    if (!btn) return
    const pre = $(btn.dataset.cb)
    if (!pre) return
    try {
      await navigator.clipboard.writeText(pre.textContent)
      btn.textContent = "copied"
      setTimeout(() => (btn.textContent = "copy"), 1400)
    } catch {
      toast("Could not copy", "err")
    }
  })

  // Empty-state suggestions.
  for (const b of $("empty")?.querySelectorAll(".empty-suggest button") ?? []) {
    b.addEventListener("click", () => {
      const input = $("input")
      input.value = b.textContent
      grow()
      input.focus()
    })
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("settings").hidden) {
      closeSettings()
      return
    }
    const inField = e.target.closest("input, textarea, select")
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault()
      $("input").focus()
      return
    }
    if (inField) return
    if (e.key === "Escape" && busy) {
      abortTurn()
      return
    }
    if (e.key === "n" || e.key === "N") {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      newSession()
      return
    }
    // Permission shortcuts: 1 = allow once, 2 = always, 3 = deny.
    if (["1", "2", "3"].includes(e.key)) {
      const card = $("messages").querySelector(".perm:not(.decided)")
      if (card) card.querySelectorAll(".perm-actions button")[+e.key - 1]?.click()
    }
  })
}

// ---------------------------------------------------------------- settings

const MODEL_SUGGESTIONS = {
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5", "claude-3-7-sonnet-latest"],
  openai: ["gpt-5", "gpt-5-mini", "gpt-4o", "o3", "o4-mini"],
}

// Masked values shown when the modal opens; a key field is only sent back
// when it differs from what was displayed (empty = clear the stored key).
let settingsOrigins = {}

function fillModelSuggestions(provider) {
  const dl = $("model-options")
  dl.innerHTML = ""
  const list = MODEL_SUGGESTIONS[provider] ?? MODEL_SUGGESTIONS.anthropic
  for (const m of list) dl.appendChild(el("option", null, m))
}

function openSettings() {
  fetch("/api/config")
    .then((r) => (r.ok ? r.json() : Promise.reject(r)))
    .then((c) => {
      settingsOrigins = {
        "set-anthropic-key": c.anthropicKey ?? "",
        "set-openai-key": c.openaiKey ?? "",
      }
      $("set-provider").value = c.provider ?? ""
      $("set-anthropic-key").value = c.anthropicKey ?? ""
      $("set-openai-key").value = c.openaiKey ?? ""
      $("set-openai-base").value = c.openaiBaseUrl ?? ""
      $("set-model").value = c.model ?? ""
      $("set-thinking").value = c.thinking ?? "off"
      fillModelSuggestions(c.provider)
      $("set-config-path").textContent = c.configPath ?? "~/.anvil.json"
      $("settings").hidden = false
      $("settings-backdrop").hidden = false
    })
    .catch(() => toast("Could not load settings", "err"))
}

function closeSettings() {
  $("settings").hidden = true
  $("settings-backdrop").hidden = true
}

async function saveSettings() {
  const ak = $("set-anthropic-key").value
  const ok = $("set-openai-key").value
  const patch = {
    provider: $("set-provider").value,
    model: $("set-model").value.trim(),
    thinking: $("set-thinking").value,
    openaiBaseUrl: $("set-openai-base").value.trim(),
  }
  if (ak !== settingsOrigins["set-anthropic-key"]) patch.anthropicKey = ak
  if (ok !== settingsOrigins["set-openai-key"]) patch.openaiKey = ok

  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => null)
  if (!res || !res.ok) {
    const err = res ? (await res.json().catch(() => ({}))) : {}
    toast(err.error ?? "Could not save settings", "err")
    return
  }
  const body = await res.json().catch(() => ({}))
  closeSettings()
  toast(body.note ?? "Settings saved — applies to new sessions", "ok")
}

// ---------------------------------------------------------------- init

async function init() {
  applyTheme(initialTheme())
  wireComposer()
  wireChrome()

  fetch("/api/health")
    .then((r) => r.json())
    .then((h) => ($("side-version").textContent = `v${h.version ?? "?"}`))
    .catch(() => {})

  refreshList()
  setInterval(() => {
    if (document.visibilityState === "visible") refreshList()
  }, 4000)

  const wanted = new URLSearchParams(location.search).get("session")
  if (wanted) await openSession(wanted)
  else await newSession()
}

init()
