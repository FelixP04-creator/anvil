// anvil web UI — vanilla JS. Talks to the anvil server over REST + SSE.

const $ = (id) => document.getElementById(id)

let sessionId = null
let source = null
let currentTextEl = null
let busy = false

/** toolName -> queue of open chip elements (tool events carry no id). */
const openTools = new Map()
/** ids of rendered permission cards (the event may arrive twice after a reconnect). */
const renderedPerms = new Set()

function hideEmpty() {
  const el = $("empty")
  if (el) el.remove()
}

function append(el) {
  hideEmpty()
  $("messages").appendChild(el)
  scrollBottom()
}

function scrollBottom() {
  const scroller = $("scroller")
  scroller.scrollTop = scroller.scrollHeight
}

function appendUser(text) {
  const el = document.createElement("div")
  el.className = "msg user"
  el.textContent = text
  append(el)
}

function appendAssistant(text, streaming = false) {
  const el = document.createElement("div")
  el.className = "msg assistant"
  const role = document.createElement("div")
  role.className = "msg-role"
  role.textContent = "anvil"
  const body = document.createElement("div")
  body.className = streaming ? "msg-text streaming" : "msg-text"
  body.textContent = text
  el.append(role, body)
  append(el)
  return body
}

function ensureAssistant() {
  if (currentTextEl) return currentTextEl
  currentTextEl = appendAssistant("", true)
  return currentTextEl
}

function finishAssistant() {
  if (currentTextEl) currentTextEl.classList.remove("streaming")
  currentTextEl = null
}

function formatInput(name, input) {
  if (!input) return name
  if (name === "Bash") return String(input.command ?? "")
  if (input.file_path !== undefined) return String(input.file_path)
  if (input.pattern !== undefined) return String(input.pattern)
  if (input.description !== undefined) return String(input.description)
  return JSON.stringify(input).slice(0, 120)
}

function buildTool(name, argsText, status, statusCls, outputText) {
  const chip = document.createElement("div")
  chip.className = "tool"
  const head = document.createElement("div")
  head.className = "tool-head"
  const statusEl = document.createElement("span")
  statusEl.className = `tool-status ${statusCls}`.trim()
  statusEl.textContent = status
  const nameEl = document.createElement("span")
  nameEl.className = "tool-name"
  nameEl.textContent = String(name ?? "?")
  const argsEl = document.createElement("span")
  argsEl.className = "tool-args"
  argsEl.textContent = argsText
  argsEl.title = argsText
  head.append(statusEl, nameEl, argsEl)
  chip.append(head)
  if (outputText && outputText.trim()) {
    const out = document.createElement("pre")
    out.className = "tool-output"
    out.textContent =
      outputText.length > 8000 ? `${outputText.slice(0, 8000)}\n… [truncated]` : outputText
    chip.append(out)
  }
  return chip
}

function onToolStart(ev) {
  const chip = buildTool(ev.toolName, formatInput(ev.toolName, ev.input), "…", "")
  append(chip)
  const list = openTools.get(ev.toolName) ?? []
  list.push(chip)
  openTools.set(ev.toolName, list)
}

function onToolEnd(ev) {
  const list = openTools.get(ev.toolName) ?? []
  const chip = list.shift()
  if (!chip) return
  const status = chip.querySelector(".tool-status")
  status.textContent = ev.ok ? "ok" : "error"
  status.className = `tool-status ${ev.ok ? "ok" : "err"}`
  const text = String(ev.text ?? "")
  if (text.trim()) {
    const out = document.createElement("pre")
    out.className = "tool-output"
    out.textContent = text.length > 8000 ? `${text.slice(0, 8000)}\n… [truncated]` : text
    chip.append(out)
  }
}

function onPermission(ev) {
  if (renderedPerms.has(ev.id)) return
  renderedPerms.add(ev.id)
  const card = document.createElement("div")
  card.className = "perm"
  const q = document.createElement("div")
  q.className = "perm-q"
  q.textContent = ev.detail || String(ev.toolName)
  const actions = document.createElement("div")
  actions.className = "perm-actions"
  const options = [
    ["Allow once", "once", ""],
    ["Always allow", "always", ""],
    ["Deny", "deny", "danger"],
  ]
  for (const [label, answer, cls] of options) {
    const b = document.createElement("button")
    if (cls) b.className = cls
    b.textContent = label
    b.addEventListener("click", async () => {
      for (const btn of actions.querySelectorAll("button")) btn.disabled = true
      card.classList.add("decided")
      const res = await fetch(`/api/sessions/${sessionId}/permissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ev.id, answer }),
      })
      if (!res.ok) {
        for (const btn of actions.querySelectorAll("button")) btn.disabled = false
        card.classList.remove("decided")
      }
    })
    actions.appendChild(b)
  }
  card.append(q, actions)
  append(card)
}

function appendError(text) {
  const el = document.createElement("div")
  el.className = "error-line"
  el.textContent = text
  append(el)
}

function setBusy(b) {
  busy = b
  $("send").disabled = b
}

/** Replay a finished conversation (page load / deep link). */
function renderTranscript(entries) {
  for (const e of entries) {
    if (e.role === "user") appendUser(e.text)
    else if (e.role === "assistant") appendAssistant(e.text)
    else if (e.role === "tool") {
      append(
        buildTool(e.name, formatInput(e.name, e.args), e.ok ? "ok" : "error", e.ok ? "ok" : "err", e.output),
      )
    }
  }
}

function handle(ev) {
  switch (ev.type) {
    case "assistant_delta":
      ensureAssistant().textContent += ev.text ?? ""
      scrollBottom()
      break
    case "assistant_text":
      finishAssistant()
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
    case "denied":
      appendError(`denied ${ev.toolName}: ${ev.text ?? ""}`)
      break
    case "error":
      appendError(String(ev.text ?? "unknown error"))
      break
    case "turn_end":
      finishAssistant()
      setBusy(false)
      break
    case "session":
      if (ev.model) $("model").textContent = ev.model
      if (ev.cwd) $("cwd").textContent = ev.cwd
      if (ev.mode) $("mode").value = ev.mode
      if (ev.busy) setBusy(true)
      if (ev.pendingPermission) onPermission(ev.pendingPermission)
      break
    case "mode_changed":
      $("mode").value = ev.mode
      break
  }
}

function connect() {
  if (source) source.close()
  source = new EventSource(`/api/sessions/${sessionId}/events`)
  source.onmessage = (e) => {
    try {
      handle(JSON.parse(e.data))
    } catch {
      // ignore malformed frames
    }
  }
}

async function sendNow() {
  if (busy || !sessionId) return
  const input = $("input")
  const text = input.value.trim()
  if (!text) return
  input.value = ""
  input.style.height = "auto"
  appendUser(text)
  setBusy(true)
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      appendError(err.error ?? `request failed (HTTP ${res.status})`)
      setBusy(false)
    }
  } catch (err) {
    appendError(String(err))
    setBusy(false)
  }
}

function wireComposer() {
  const input = $("input")
  const grow = () => {
    input.style.height = "auto"
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`
  }
  input.addEventListener("input", grow)
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendNow()
    }
  })
  $("send").addEventListener("click", sendNow)
  $("mode").addEventListener("change", async (e) => {
    const res = await fetch(`/api/sessions/${sessionId}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: e.target.value }),
    })
    if (!res.ok) e.target.value = "default"
  })
}

async function init() {
  // Deep link: ?session=<id> reopens an existing session; otherwise create one.
  let s = null
  const wanted = new URLSearchParams(location.search).get("session")
  if (wanted) {
    const res = await fetch(`/api/sessions/${wanted}`)
    if (res.ok) s = await res.json()
  }
  if (!s) {
    const res = await fetch("/api/sessions", { method: "POST" })
    if (!res.ok) {
      appendError("could not create a session (is the anvil server running?)")
      return
    }
    s = await res.json()
  }
  sessionId = s.id
  $("model").textContent = s.model
  $("cwd").textContent = s.cwd
  $("empty-cwd").textContent = s.cwd
  $("mode").value = s.mode
  connect()
  wireComposer()
  if (s.busy) setBusy(true)
  // Replay the conversation that happened before this page load.
  const t = await fetch(`/api/sessions/${sessionId}/transcript`)
  if (t.ok) {
    const data = await t.json()
    renderTranscript(data.entries ?? [])
  }
  $("input").focus()
}

init()
