// anvil web UI — vanilla JS, zero dependencies.
//
// Streaming model: deltas land in a buffer and the message is re-rendered as
// markdown ~10 times a second (rAF-throttled) — so answers read as formatted
// markdown from the very first token instead of a squashed raw-text block
// that only gets formatted when the message completes.

import { escapeHtml, renderMarkdown } from "./md.js"

const $ = (id) => document.getElementById(id)

// ---------------------------------------------------------------- state

let sessionId = null
let source = null
let busy = false
let sseWasDown = false

let streamEl = null // .msg-text element currently receiving deltas
let streamWrap = null // its .msg.assistant wrapper (for the fork button)
let streamBuf = ""
let streamDirty = false
let lastStreamHtml = ""
let lastStreamRenderAt = 0
let lastStreamLen = 0
let raf = 0
let pinned = true // auto-scroll only while the user is near the bottom

let thinkWrap = null // .msg.thinking element currently receiving deltas
let thinkEl = null // its .think-body element
let thinkNode = null // the single text node inside the body
let thinkBuf = ""

const openTools = new Map() // toolName -> queue of in-flight chip elements
const renderedPerms = new Set() // permission ids already on screen
const permCards = new Map() // permId -> { card, decided }

let pendingImages = [] // { file, url } attached to the next message
let lastMsgCount = 0 // history length (fork point for /fork)
let allSessions = [] // last session listing (for the search filter)
let slashIdx = 0

// ---------------------------------------------------------------- helpers

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
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
  fork: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5.5" r="2.3"/><circle cx="6" cy="18.5" r="2.3"/><circle cx="18" cy="12" r="2.3"/><path d="M6 7.8v8.4M8 6.6c4.5 1 6.7 2.7 7.7 4.6"/></svg>',
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

function userMsg(text, images) {
  const wrap = el("div", "msg user")
  if (text) wrap.appendChild(el("div", "user-text", text))
  if (images && images.length) {
    const grid = el("div", "user-imgs")
    for (const img of images.slice(0, 6)) {
      const i = document.createElement("img")
      i.src = img.url
      i.alt = img.name || "image"
      i.title = img.name || ""
      grid.appendChild(i)
    }
    if (images.length > 6) grid.appendChild(el("span", "user-imgs-more", `+${images.length - 6}`))
    wrap.appendChild(grid)
  }
  return append(wrap)
}

function assistantMsg() {
  const wrap = el("div", "msg assistant")
  const role = el("div", "msg-role")
  role.innerHTML = ICONS.mark
  role.appendChild(el("span", null, "anvil"))
  const forkBtn = el("button", "fork-btn", null)
  forkBtn.type = "button"
  forkBtn.title = "Fork the session from this message"
  forkBtn.innerHTML = ICONS.fork
  forkBtn.addEventListener("click", () => {
    const idx = wrap.dataset.msgIndex
    if (idx === undefined || idx === "") {
      toast("No fork point for this message yet", "info")
      return
    }
    forkFrom(+idx)
  })
  role.appendChild(forkBtn)
  const text = el("div", "msg-text")
  wrap.append(role, text)
  append(wrap)
  return { wrap, text }
}

function errorLine(text) {
  append(el("div", "error-line", String(text)))
}

function systemLine(text) {
  append(el("div", "system-line", text))
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

// ---------------------------------------------------------------- file changes

function diffRowHtml(ln) {
  const cls = ln.t === "add" ? "dl-add" : ln.t === "del" ? "dl-del" : "dl-ctx"
  const sign = ln.t === "add" ? "+" : ln.t === "del" ? "−" : " "
  return `<div class="dl ${cls}"><span class="dl-no">${ln.no ?? ""}</span><span class="dl-nn">${ln.nn ?? ""}</span><span class="dl-sign">${sign}</span><span class="dl-text">${escapeHtml(ln.text) || " "}</span></div>`
}

/** Long context runs collapse to 2 + 2 lines around a "… n lines" gap. */
function diffHtml(lines) {
  const MAX_CTX = 6
  let html = ""
  let i = 0
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.gap) {
      html += `<div class="dl-gap">⋯ ${ln.gap} lines</div>`
      i++
      continue
    }
    if (ln.t === "ctx") {
      let j = i
      while (j < lines.length && lines[j].t === "ctx" && !lines[j].gap) j++
      const run = j - i
      if (run <= MAX_CTX) {
        for (let k = i; k < j; k++) html += diffRowHtml(lines[k])
      } else {
        for (let k = i; k < i + 2; k++) html += diffRowHtml(lines[k])
        html += `<div class="dl-gap">⋯ ${run - 4} lines</div>`
        for (let k = j - 2; k < j; k++) html += diffRowHtml(lines[k])
      }
      i = j
    } else {
      html += diffRowHtml(ln)
      i++
    }
  }
  return html
}

function buildFileCard(c) {
  const card = el("div", "filecard")
  const head = el("div", "filecard-head")
  const ic = el("span", "filecard-ic")
  ic.innerHTML = ICONS[c.kind === "edit" ? "Edit" : "Write"] ?? ICONS.tool
  const pathEl = el("span", "filecard-path", c.path)
  pathEl.title = c.path
  const stats = el("span", "filecard-stats")
  stats.appendChild(el("span", "fc-add", `+${c.additions ?? 0}`))
  stats.appendChild(el("span", "fc-del", `−${c.deletions ?? 0}`))
  if (c.subagent) stats.appendChild(el("span", "fc-sub", "subagent"))
  head.append(ic, pathEl, stats)
  head.insertAdjacentHTML("beforeend", ICONS.caret)
  const lines = c.diff ?? []
  const body = el("div", "filecard-body")
  if (lines.length) {
    body.innerHTML = `<div class="diff">${diffHtml(lines)}</div>`
  } else {
    body.appendChild(el("div", "diff-note", "no diff details stored"))
  }
  card.append(head, body)
  head.addEventListener("click", () => card.classList.toggle("open"))
  if (lines.length <= 40) card.classList.add("open")
  return card
}

function renderChanges(changes) {
  if (!changes || !changes.length) return
  for (const c of changes) append(buildFileCard(c))
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
  maybeNotify("anvil needs permission", ev.detail || ev.toolName)
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
//
// Live markdown: each flush re-renders the buffer through renderMarkdown.
// The rAF loop only keeps ticking while there are unflushed deltas.

function beginStream() {
  const m = assistantMsg()
  streamWrap = m.wrap
  streamEl = m.text
  streamEl.classList.add("streaming")
  streamBuf = ""
  streamDirty = true
  lastStreamHtml = ""
  lastStreamRenderAt = 0
  lastStreamLen = 0
  scheduleStream()
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
  streamDirty = true
  setStatus("working", "responding…")
  scheduleStream()
}

function onThinkingDelta(text) {
  if (!thinkEl) beginThinking()
  thinkBuf += text
  setStatus("working", "thinking…")
  scheduleStream()
}

function scheduleStream() {
  if (!raf) raf = requestAnimationFrame(flushStream)
}

function flushStream() {
  raf = 0
  let changed = false
  if (thinkNode && thinkBuf !== thinkNode.data) {
    thinkNode.data = thinkBuf
    changed = true
  }
  if (streamEl && streamDirty) {
    const now = Date.now()
    // ~10 renders/second while streaming (or sooner for a big chunk) —
    // enough to read as live markdown without re-parsing per token.
    if (now - lastStreamRenderAt >= 100 || streamBuf.length - lastStreamLen >= 1200) {
      lastStreamRenderAt = now
      lastStreamLen = streamBuf.length
      streamDirty = false
      const html = renderMarkdown(streamBuf)
      if (html !== lastStreamHtml) {
        lastStreamHtml = html
        streamEl.innerHTML = html
        changed = true
      }
    } else {
      scheduleStream()
    }
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
  if (!streamEl) return null
  const final = finalText !== undefined && finalText !== null ? finalText : streamBuf
  streamEl.classList.remove("streaming")
  streamEl.innerHTML = renderMarkdown(final)
  const wrap = streamWrap
  streamEl = null
  streamWrap = null
  streamBuf = ""
  streamDirty = false
  if (pinned) scrollBottom()
  updateJump()
  return wrap
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
  document.title = b ? "⏳ anvil — working" : "anvil"
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
  const chip = $("todo-chip")
  if (!todos || todos.length === 0) {
    panel.dataset.empty = "true"
    if (chip) chip.hidden = true
    return
  }
  panel.dataset.empty = "false"
  const done = todos.filter((t) => t.status === "completed").length
  $("todo-count").textContent = `${done}/${todos.length}`
  if (chip) {
    chip.hidden = false
    $("todo-chip-count").textContent = `${done}/${todos.length}`
  }
  for (const t of todos) {
    const li = el("li", t.status)
    li.append(el("span", "todo-ic"))
    li.append(el("span", "todo-txt", t.content))
    list.appendChild(li)
  }
}

function setModelPill(s) {
  const sel = $("model")
  const m = s.model ?? ""
  const known =
    s.kind === "local"
      ? (localRuntime?.ok ? MODEL_SUGGESTIONS.local : [])
      : MODEL_SUGGESTIONS[s.kind] ?? []
  const opts = [m, ...known].filter((v, i, a) => v && a.indexOf(v) === i)
  sel.innerHTML = ""
  for (const o of opts) sel.appendChild(el("option", null, o))
  sel.value = m
  sel.title =
    s.thinking && s.thinking !== "off"
      ? `Model — thinking: ${s.thinking} (change applies from the next message)`
      : "Model — change applies from the next message"
  if (s.kind === "local" && !localRuntime) fetchLocalModels().then(() => setModelPill(s))
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
  if (s.msgCount !== undefined) lastMsgCount = s.msgCount
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

function fuzzyMatch(q, text) {
  const needle = q.toLowerCase()
  const hay = (text || "").toLowerCase()
  if (!needle) return true
  if (hay.includes(needle)) return true
  let i = 0
  for (const ch of hay) {
    if (ch === needle[i]) i++
    if (i === needle.length) return true
  }
  return false
}

function renderList(list) {
  allSessions = list
  const q = $("sess-search").value.trim()
  const shown = q ? list.filter((s) => fuzzyMatch(q, s.title) || fuzzyMatch(q, s.model)) : list
  const nav = $("session-list")
  nav.innerHTML = ""
  if (!shown.length) {
    nav.appendChild(el("div", "sess-empty", list.length ? "No matches" : "No sessions yet"))
    return
  }
  for (const s of shown) {
    const item = el("div", "sess")
    if (s.id === sessionId) item.classList.add("active")
    if (s.busy) item.classList.add("busy")
    if (s.needsPermission) item.classList.add("perm")

    item.appendChild(el("span", "sess-dot"))
    item.appendChild(el("div", "sess-title", s.title))
    const meta = `${s.turns ?? 0} turn${(s.turns ?? 0) === 1 ? "" : "s"} · ${timeAgo(s.updatedAt ?? s.createdAt)}`
    item.appendChild(el("div", "sess-meta", s.forkedFrom ? `fork · ${meta}` : meta))

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
  if (s.msgCount !== undefined) lastMsgCount = s.msgCount

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

  // Replay the transcript, then the last turn's file changes, then any
  // pending permission prompt, in that visual order — the SSE snapshot
  // that follows is deduplicated.
  const t = await fetch(`/api/sessions/${id}/transcript`).catch(() => null)
  if (t && t.ok) {
    const data = await t.json()
    renderTranscript(data.entries ?? [])
  }
  renderChanges(s.changes)
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
    if (e.role === "user") {
      userMsg(e.text, (e.images ?? []).map((im) => ({ url: `data:${im.mediaType};base64,${im.data}`, name: "" })))
    } else if (e.role === "thinking") {
      renderThinking(e.text)
    } else if (e.role === "assistant") {
      const { wrap, text } = assistantMsg()
      text.innerHTML = renderMarkdown(e.text)
      if (e.msgIndex !== undefined) wrap.dataset.msgIndex = e.msgIndex
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
    return null
  }
  const created = await res.json()
  refreshList()
  await openSession(created.id)
  return created.id
}

async function forkFrom(idx) {
  const res = await fetch(`/api/sessions/${sessionId}/fork`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgIndex: idx }),
  }).catch(() => null)
  if (!res || !res.ok) {
    const err = res ? await res.json().catch(() => ({})) : {}
    toast(err.error ?? "Could not fork the session", "err")
    return
  }
  const f = await res.json()
  toast("Forked — new session continues from that point", "ok")
  await openSession(f.id)
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
    renderChanges(s.changes)
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
    case "assistant_text": {
      const wrap = endStream(ev.text)
      // The server tags the finished message with its history index —
      // that is the fork point for this message.
      if (wrap && ev.msgIndex !== undefined) wrap.dataset.msgIndex = ev.msgIndex
      break
    }
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
    case "file_change":
      append(buildFileCard(ev))
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
      maybeNotify("anvil error", ev.text ?? "unknown error")
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
    case "turn_end": {
      endStream(undefined)
      if (ev.usage && (ev.usage.input || ev.usage.output)) {
        append(el("div", "turn-usage", `↑ ${fmtTokens(ev.usage.input)} in · ↓ ${fmtTokens(ev.usage.output)} out this turn`))
      }
      if (ev.changes && ev.changes.length) {
        const n = ev.changes.length
        const add = ev.changes.reduce((x, c) => x + (c.additions ?? 0), 0)
        const del = ev.changes.reduce((x, c) => x + (c.deletions ?? 0), 0)
        append(el("div", "turn-changes", `${n} file${n === 1 ? "" : "s"} changed · +${add} −${del}`))
      }
      setBusy(false)
      setStatus("", "idle")
      lastMsgCount = ev.msgCount ?? lastMsgCount
      maybeNotify("Turn finished", $("session-title").textContent || "anvil")
      refreshState()
      refreshList()
      break
    }
  }
}

// ---------------------------------------------------------------- images

function addImageFiles(fileList) {
  const files = [...(fileList ?? [])]
  for (const f of files) {
    if (!f) continue
    if (!f.type || !f.type.startsWith("image/")) {
      toast(`skipped "${f.name}": not an image`, "err")
      continue
    }
    if (pendingImages.length >= 8) {
      toast("Max 8 images per message", "err")
      break
    }
    if (f.size > 10 * 1024 * 1024) {
      toast(`"${f.name}" is too big (max 10 MB)`, "err")
      continue
    }
    pendingImages.push({ file: f, url: URL.createObjectURL(f) })
  }
  renderImagePreviews()
}

function renderImagePreviews() {
  const row = $("img-previews")
  row.innerHTML = ""
  row.hidden = pendingImages.length === 0
  pendingImages.forEach((p, i) => {
    const d = el("div", "img-prev")
    const img = document.createElement("img")
    img.src = p.url
    img.alt = p.file.name
    d.appendChild(img)
    const x = el("button", "img-prev-x", "×")
    x.type = "button"
    x.title = "Remove image"
    x.addEventListener("click", () => {
      URL.revokeObjectURL(p.url)
      pendingImages.splice(i, 1)
      renderImagePreviews()
    })
    d.appendChild(x)
    row.appendChild(d)
  })
}

function clearImages() {
  for (const p of pendingImages) URL.revokeObjectURL(p.url)
  pendingImages = []
  renderImagePreviews()
}

function readImages() {
  return Promise.all(
    pendingImages.map((p) =>
      new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => {
          const s = String(r.result)
          const i = s.indexOf("base64,")
          resolve({ mediaType: s.slice(5, i), data: s.slice(i + 7) })
        }
        r.onerror = () => reject(r.error)
        r.readAsDataURL(p.file)
      }),
    ),
  )
}

// ---------------------------------------------------------------- slash commands

const SLASH_COMMANDS = [
  { cmd: "/help", usage: "/help", desc: "list all commands" },
  { cmd: "/new", usage: "/new", desc: "start a new session" },
  { cmd: "/fork", usage: "/fork", desc: "fork from the last message" },
  { cmd: "/model", usage: "/model [name]", desc: "show or switch the model" },
  { cmd: "/thinking", usage: "/thinking <off|low|medium|high>", desc: "set the thinking effort" },
  { cmd: "/mode", usage: "/mode <default|acceptEdits|plan|bypass>", desc: "set the permission mode" },
  { cmd: "/export", usage: "/export [md|html]", desc: "download the conversation" },
  { cmd: "/notify", usage: "/notify [on|off]", desc: "browser notifications" },
]

function slashPop() {
  return $("slash-pop")
}

function hideSlash() {
  slashPop().hidden = true
  slashIdx = 0
}

function updateSlash() {
  const v = $("input").value
  const pop = slashPop()
  const m = v.match(/^\/([a-z]*)\s*$/)
  if (!m) {
    hideSlash()
    return
  }
  const filtered = SLASH_COMMANDS.filter((c) => c.cmd.startsWith("/" + m[1]))
  if (!filtered.length) {
    hideSlash()
    return
  }
  if (slashIdx >= filtered.length) slashIdx = 0
  pop.innerHTML = ""
  filtered.forEach((c, i) => {
    const row = el("div", "slash-item" + (i === slashIdx ? " active" : ""))
    row.append(el("span", "slash-cmd", c.usage), el("span", "slash-desc", c.desc))
    row.addEventListener("mousedown", (e) => {
      e.preventDefault()
      pickSlash(c.cmd)
    })
    pop.appendChild(row)
  })
  pop.hidden = false
}

function pickSlash(cmd) {
  const input = $("input")
  input.value = cmd + " "
  hideSlash()
  grow()
  input.focus()
}

function handleCommand(text) {
  const parts = text.trim().split(/\s+/)
  const name = parts[0].toLowerCase()
  const arg = parts[1]
  switch (name) {
    case "/help":
      systemLine(SLASH_COMMANDS.map((c) => `${c.usage.padEnd(34)}  ${c.desc}`).join("\n"))
      break
    case "/new":
      newSession()
      break
    case "/fork": {
      const idx = lastMsgCount - 1
      if (idx < 0) systemLine("nothing to fork yet — send a message first")
      else forkFrom(idx)
      break
    }
    case "/model":
      if (arg) setModel(arg)
      else systemLine(`current model: ${$("model").value || "—"}`)
      break
    case "/thinking": {
      if (!["off", "low", "medium", "high"].includes(arg)) {
        systemLine("usage: /thinking <off|low|medium|high>")
        break
      }
      applyThinking(arg)
      break
    }
    case "/mode": {
      if (!["default", "acceptEdits", "plan", "bypass"].includes(arg)) {
        systemLine("usage: /mode <default|acceptEdits|plan|bypass>")
        break
      }
      applyMode(arg)
      break
    }
    case "/export":
      doExport(arg === "html" ? "html" : "md")
      break
    case "/notify":
      toggleNotify(arg === "off")
      break
    default:
      systemLine(`unknown command: ${name} — try /help`)
  }
}

// ---------------------------------------------------------------- composer

function grow() {
  const input = $("input")
  input.style.height = "auto"
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`
}

async function postMessage(body) {
  return fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null)
}

async function sendNow() {
  if (busy) return
  const input = $("input")
  const text = input.value.trim()
  const hasImages = pendingImages.length > 0
  if (!text && !hasImages) return
  hideSlash()
  // Slash commands run client-side and never reach the server.
  if (text.startsWith("/")) {
    const known = SLASH_COMMANDS.some((c) => text === c.cmd || text.startsWith(c.cmd + " "))
    if (known) {
      input.value = ""
      input.style.height = "auto"
      handleCommand(text)
      return
    }
  }
  if (!sessionId) {
    // No session yet (e.g. creation failed on load) — don't fail silently.
    if (!(await newSession())) return
  }
  let images
  if (hasImages) {
    try {
      images = await readImages()
    } catch {
      errorLine("Could not read one of the attached images")
      return
    }
  }
  input.value = ""
  input.style.height = "auto"
  clearImages()
  userMsg(
    text,
    images ? images.map((im) => ({ url: `data:${im.mediaType};base64,${im.data}`, name: "" })) : undefined,
  )
  setBusy(true)
  const body = { text, images }
  const res = await postMessage(body)
  if (!res) {
    errorLine("Could not reach the anvil server")
    setStatus("error", "error")
    setBusy(false)
    return
  }
  if (!res.ok) {
    if (res.status === 404) {
      // The session no longer exists on the server (e.g. after a restart).
      // Start fresh and retry the message once.
      setBusy(false)
      if (!(await newSession())) return
      userMsg(text, images ? images.map((im) => ({ url: `data:${im.mediaType};base64,${im.data}`, name: "" })) : undefined)
      setBusy(true)
      const retry = await postMessage(body)
      if (!retry) {
        errorLine("Could not reach the anvil server")
        setStatus("error", "error")
        setBusy(false)
        return
      }
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({}))
        errorLine(err.error ?? `request failed (HTTP ${retry.status})`)
        setStatus("error", "error")
        setBusy(false)
      }
      return
    }
    const err = await res.json().catch(() => ({}))
    errorLine(err.error ?? `request failed (HTTP ${res.status})`)
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

async function setModel(model) {
  if (!sessionId || !model) return
  const res = await fetch(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  }).catch(() => null)
  if (!res || !res.ok) {
    const err = res ? (await res.json().catch(() => ({}))) : {}
    toast(err.error ?? "Could not switch the model", "err")
    await refreshState() // reverts the pill
    return
  }
  const s = await res.json()
  setModelPill(s)
  toast(`Model: ${model}`, "ok")
}

async function applyThinking(level) {
  if (!sessionId) return
  const res = await fetch(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thinking: level }),
  }).catch(() => null)
  if (!res || !res.ok) {
    toast("Could not change the thinking level", "err")
    return
  }
  const s = await res.json()
  setModelPill(s)
  toast(`Thinking: ${level}`, "ok")
}

async function applyMode(mode) {
  if (!sessionId) return
  const res = await fetch(`/api/sessions/${sessionId}/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  }).catch(() => null)
  if (!res || !res.ok) {
    $("mode").value = "default"
    toast("Could not change the mode", "err")
    return
  }
  $("mode").value = mode
}

function wireComposer() {
  const input = $("input")
  input.addEventListener("input", () => {
    grow()
    updateSlash()
  })
  input.addEventListener("keydown", (e) => {
    const pop = slashPop()
    if (!pop.hidden) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        slashIdx = (slashIdx + (e.key === "ArrowDown" ? 1 : pop.children.length - 1)) % pop.children.length
        updateSlash()
        return
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault()
        const active = pop.children[slashIdx]
        const usage = active?.querySelector(".slash-cmd")?.textContent ?? ""
        pickSlash(usage.split(" ")[0])
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        hideSlash()
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendNow()
    }
  })
  // Pasted images (from clipboard) land in the composer.
  input.addEventListener("paste", (e) => {
    const items = e.clipboardData ? [...e.clipboardData.items] : []
    const files = items.filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean)
    if (files.length) {
      e.preventDefault()
      addImageFiles(files)
    }
  })

  $("send").addEventListener("click", () => (busy ? abortTurn() : sendNow()))
  $("mode").addEventListener("change", (e) => applyMode(e.target.value))
  $("model").addEventListener("change", (e) => {
    if (e.target.value) setModel(e.target.value)
  })

  // Image attachment: file picker, drag & drop onto the composer.
  $("attach-btn").addEventListener("click", () => $("img-input").click())
  $("img-input").addEventListener("change", (e) => {
    addImageFiles([...(e.target.files ?? [])])
    e.target.value = ""
  })
  const composer = $("composer")
  composer.addEventListener("dragover", (e) => {
    e.preventDefault()
    composer.classList.add("drag")
  })
  composer.addEventListener("dragleave", () => composer.classList.remove("drag"))
  composer.addEventListener("drop", (e) => {
    e.preventDefault()
    composer.classList.remove("drag")
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addImageFiles([...e.dataTransfer.files])
    }
  })
}

// ---------------------------------------------------------------- notifications

function notifyEnabled() {
  try {
    return localStorage.getItem("anvil-notify") !== "0"
  } catch {
    return true
  }
}

function syncNotifyBtn() {
  const on = "Notification" in window && Notification.permission === "granted" && notifyEnabled()
  const b = $("notify-btn")
  if (b) {
    b.classList.toggle("active", on)
    b.title = on ? "Notifications: on (when this tab is hidden)" : "Notifications: off"
  }
  const m = $("more-menu")?.querySelector('[data-act="notify"]')
  if (m) m.textContent = on ? "Notifications: on" : "Notifications: off"
}

async function toggleNotify(forceOff) {
  if (!("Notification" in window)) {
    toast("This browser does not support notifications", "err")
    return
  }
  if (forceOff) {
    try {
      localStorage.setItem("anvil-notify", "0")
    } catch {}
    syncNotifyBtn()
    toast("Notifications off", "info")
    return
  }
  let perm = Notification.permission
  if (perm === "default") {
    try {
      perm = await Notification.requestPermission()
    } catch {}
  }
  if (perm === "granted") {
    try {
      localStorage.setItem("anvil-notify", notifyEnabled() ? "0" : "1")
    } catch {}
    syncNotifyBtn()
    toast(notifyEnabled() ? "Notifications off" : "Notifications on", "info")
  } else {
    toast("The browser blocked notifications", "err")
  }
}

/** Fire only while the tab is hidden — never compete with the UI. */
function maybeNotify(title, body) {
  if (!("Notification" in window)) return
  if (Notification.permission !== "granted") return
  if (!notifyEnabled()) return
  if (!document.hidden) return
  try {
    const n = new Notification(title, { body: body || "anvil", tag: "anvil" })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {}
}

// ---------------------------------------------------------------- export

async function doExport(fmt) {
  if (!sessionId) return
  const [tRes, sRes] = await Promise.all([
    fetch(`/api/sessions/${sessionId}/transcript`).catch(() => null),
    fetch(`/api/sessions/${sessionId}`).catch(() => null),
  ])
  if (!tRes || !tRes.ok || !sRes || !sRes.ok) {
    toast("Could not load the session for export", "err")
    return
  }
  const entries = (await tRes.json()).entries ?? []
  const s = await sRes.json()
  const date = new Date().toISOString().slice(0, 10)
  const slug =
    String(s.title || "session").toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session"
  const name = `anvil-${slug}-${date}`
  if (fmt === "html") download(name + ".html", buildExportHtml(s, entries), "text/html")
  else download(name + ".md", buildExportMd(s, entries), "text/markdown")
  toast(`Exported as ${fmt.toUpperCase()}`, "ok")
}

function toolLine(e) {
  const args = formatInput(e.name, e.args)
  return `${e.name}${args ? " — " + args : ""}${e.ok ? "" : "  (failed)"}`
}

function buildExportMd(s, entries) {
  const L = []
  L.push(`# ${s.title || "anvil session"}`, "")
  L.push(`anvil · ${s.model ?? ""} · ${s.cwd ?? ""} · ${new Date(s.createdAt || Date.now()).toLocaleString()}`)
  const u = s.usage ?? {}
  if (u.input || u.output) L.push("", `tokens: ${u.input} in / ${u.output} out`)
  for (const e of entries) {
    if (e.role === "user") {
      L.push("", "## You", "", e.text || "")
      for (const im of e.images ?? []) {
        L.push(`_image attached: ${im.mediaType} (${Math.round((im.data?.length ?? 0) / 1024)} KB — omitted from export)_`)
      }
    } else if (e.role === "assistant") {
      L.push("", "## anvil", "", e.text)
    } else if (e.role === "tool") {
      L.push("", `### ${toolLine(e)}`, "", "```json", JSON.stringify(e.args ?? {}), "```")
      if (e.output) L.push("", "```", String(e.output).slice(0, 8000), "```")
    }
  }
  L.push("")
  return L.join("\n")
}

function buildExportHtml(s, entries) {
  const u = s.usage ?? {}
  const meta = [s.model, s.cwd, new Date(s.createdAt || Date.now()).toLocaleString()].filter(Boolean).map(escapeHtml).join(" · ")
  const body = []
  for (const e of entries) {
    if (e.role === "user") {
      body.push(`<section class="msg user"><div class="who">you</div>${e.text ? `<div class="user-text">${renderMarkdown(e.text)}</div>` : ""}`)
      for (const im of e.images ?? []) body.push(`<img src="data:${im.mediaType};base64,${im.data}" alt="attached image">`)
      body.push("</section>")
    } else if (e.role === "assistant") {
      body.push(`<section class="msg assistant"><div class="who">anvil</div>${renderMarkdown(e.text) || ""}</section>`)
    } else if (e.role === "tool") {
      body.push(
        `<section class="tool"><div class="tool-line">${escapeHtml(toolLine(e))}</div><pre>${escapeHtml(JSON.stringify(e.args ?? {}, null, 2))}</pre>${e.output ? `<pre class="tool-out">${escapeHtml(String(e.output).slice(0, 8000))}</pre>` : ""}</section>`,
      )
    }
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(s.title || "anvil session")}</title>
<style>
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1c1e21;--muted:#6b7280;--card:#f4f5f7;--border:#e3e5e8;--code:#0f1115;--code-fg:#e6e6e6}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--fg:#e7eaf0;--muted:#98a2b3;--card:#1a1e26;--border:#2a3039;--code:#0b0e12;--code-fg:#e6e6e6}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
article{max-width:860px;margin:0 auto;padding:48px 24px 80px}
h1{font-size:26px;line-height:1.25}
.meta{color:var(--muted);font-size:13px;margin-bottom:8px}
.who{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:26px 0 6px}
.msg.user .user-text{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 14px}
.msg.user img{max-width:240px;border-radius:8px;margin:6px 6px 0 0}
pre{background:var(--code);color:var(--code-fg);padding:12px 14px;border-radius:9px;overflow-x:auto;font-size:12.8px;line-height:1.55;font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
p>code,li>code{font-family:ui-monospace,Consolas,monospace;background:var(--card);border:1px solid var(--border);padding:1px 5px;border-radius:5px;font-size:.92em}
.tool{border:1px solid var(--border);border-radius:9px;padding:10px 12px;margin:10px 0;font-size:13px}
.tool-line{font-weight:600;color:var(--muted);margin-bottom:8px}
code{font-family:ui-monospace,Consolas,monospace}
a{color:#4a7fd6}
blockquote{margin:8px 0;padding:6px 14px;border-left:3px solid var(--border);color:var(--muted)}
</style>
</head>
<body>
<article>
<h1>${escapeHtml(s.title || "anvil session")}</h1>
<div class="meta">${meta}${u.input || u.output ? ` · ${u.input} in / ${u.output} out tokens` : ""}</div>
${body.join("\n")}
</article>
</body>
</html>
`
}

function download(name, content, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
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

  $("notify-btn").addEventListener("click", () => toggleNotify())

  // Todo chip (mobile only, via CSS): opens the sidebar where the panel lives.
  $("todo-chip").addEventListener("click", () => {
    $("sidebar").classList.add("open")
    $("backdrop").classList.add("show")
  })

  // Export menu (md / html) in the top bar.
  const exportMenu = $("export-menu")
  $("export-btn").addEventListener("click", (e) => {
    e.stopPropagation()
    exportMenu.hidden = !exportMenu.hidden
  })
  document.addEventListener("click", () => {
    exportMenu.hidden = true
  })
  for (const b of exportMenu.querySelectorAll("button")) {
    b.addEventListener("click", (e) => {
      e.stopPropagation()
      exportMenu.hidden = true
      doExport(b.dataset.fmt)
    })
  }

  // Mobile overflow menu ("More"): at <=600px the top bar only has room
  // for the selects + settings + offline, so export / notify / copy-link
  // move in here (their buttons are hidden by CSS at that width).
  const moreMenu = $("more-menu")
  $("more-btn").addEventListener("click", (e) => {
    e.stopPropagation()
    moreMenu.hidden = !moreMenu.hidden
  })
  document.addEventListener("click", () => {
    moreMenu.hidden = true
  })
  for (const b of moreMenu.querySelectorAll("button")) {
    b.addEventListener("click", (e) => {
      e.stopPropagation()
      moreMenu.hidden = true
      switch (b.dataset.act) {
        case "export-md":
          doExport("md")
          break
        case "export-html":
          doExport("html")
          break
        case "notify":
          void toggleNotify()
          break
        case "copy-link":
          $("copy-link").click() // hidden, but programmatic clicks still work
          break
      }
    })
  }

  // Session list search.
  $("sess-search").addEventListener("input", () => renderList(allSessions))

  $("settings-btn").addEventListener("click", openSettings)
  $("settings-close").addEventListener("click", closeSettings)
  $("settings-backdrop").addEventListener("click", closeSettings)
  $("set-save").addEventListener("click", saveSettings)
  $("set-provider").addEventListener("change", () => {
    fillModelSuggestions($("set-provider").value)
    updateHsnrFields()
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
  hsnr: ["Qwen/Qwen3.8-27B", "zai-org/GLM-5.3", "ultrabrain", "smallbrain"],
  // Filled dynamically from /api/local-models (Ollama / LM Studio).
  local: [],
}

// Last known local runtime (server-side probe of Ollama / LM Studio).
let localRuntime = null // { ok, vendor, baseUrl, models, error }

async function fetchLocalModels() {
  try {
    const res = await fetch("/api/local-models", { cache: "no-store" })
    if (!res.ok) throw new Error(String(res.status))
    localRuntime = await res.json()
  } catch (err) {
    localRuntime = { ok: false, error: String(err).slice(0, 120) }
  }
  const el = $("local-status")
  if ($("set-provider").value === "local" && !$("settings").hidden) {
    if (localRuntime.ok) {
      el.textContent = `✓ ${localRuntime.models.length} model(s) via ${localRuntime.vendor} at ${localRuntime.baseUrl}`
    } else {
      el.textContent = `✗ ${localRuntime.error ?? "no local runtime found"} — start Ollama (ollama serve) or LM Studio, or set a base URL.`
    }
    el.hidden = false
  }
  return localRuntime
}

// Masked values shown when the modal opens; a key field is only sent back
// when it differs from what was displayed (empty = clear the stored key).
let settingsOrigins = {}

function updateHsnrFields() {
  const p = $("set-provider").value
  const on = p === "hsnr"
  $("hsnr-fields-key").hidden = !on
  $("hsnr-fields-base").hidden = !on
  $("local-fields-base").hidden = p !== "local"
  if (p !== "local") $("local-status").hidden = true
}

function fillModelSuggestions(provider) {
  const dl = $("model-options")
  dl.innerHTML = ""
  if (provider === "local") {
    // Fill from the detected runtime (fetch if unknown), plus whatever the
    // runtime reported last time this page load saw it.
    const rt = localRuntime
    if (rt && rt.ok) MODEL_SUGGESTIONS.local = rt.models
    else if (rt) MODEL_SUGGESTIONS.local = []
    for (const m of MODEL_SUGGESTIONS.local) dl.appendChild(el("option", null, m))
    if (!rt) fetchLocalModels().then((r) => fillModelSuggestions("local"))
    return
  }
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
        "set-hsnr-key": c.hsnrKey ?? "",
      }
      $("set-provider").value = c.provider ?? ""
      $("set-anthropic-key").value = c.anthropicKey ?? ""
      $("set-openai-key").value = c.openaiKey ?? ""
      $("set-openai-base").value = c.openaiBaseUrl ?? ""
      $("set-hsnr-key").value = c.hsnrKey ?? ""
      $("set-hsnr-base").value = c.hsnrBaseUrl ?? ""
      $("set-local-base").value = c.localBaseUrl ?? ""
      $("set-model").value = c.model ?? ""
      $("set-thinking").value = c.thinking ?? "off"
      fillModelSuggestions(c.provider)
      updateHsnrFields()
      if (c.provider === "local") fetchLocalModels()
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
  const hk = $("set-hsnr-key").value
  const patch = {
    provider: $("set-provider").value,
    model: $("set-model").value.trim(),
    thinking: $("set-thinking").value,
    openaiBaseUrl: $("set-openai-base").value.trim(),
  }
  if (ak !== settingsOrigins["set-anthropic-key"]) patch.anthropicKey = ak
  if (ok !== settingsOrigins["set-openai-key"]) patch.openaiKey = ok
  if (hk !== settingsOrigins["set-hsnr-key"]) patch.hsnrKey = hk
  patch.hsnrBaseUrl = $("set-hsnr-base").value.trim()
  patch.localBaseUrl = $("set-local-base").value.trim()

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
  syncNotifyBtn()
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
