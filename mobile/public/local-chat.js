// anvil · offline model — a small LLM that runs entirely in the browser
// (WebGPU) via the WebLLM engine (Apache-2.0, loaded from CDN on demand).
// No server, no API key. This is pure chat: the model has no tools.

import { renderMarkdown, escapeHtml } from "./md.js"

// Pinned engine build. The library itself (~7 MB) plus the TVM runtime
// (~50 MB) are fetched once and cached in CacheStorage; after that the
// page works offline. Model weights come from Hugging Face (mlc-ai).
const WEBLLM_URL = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/lib/index.js"

const MODELS = [
  {
    id: "Qwen2-0.5B-Instruct-q4f16_1-MLC",
    name: "Qwen2 0.5B",
    desc: "Fastest — good for phones and quick questions.",
    size: "~350 MB",
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 1B",
    desc: "Recommended balance of speed and quality.",
    size: "~750 MB",
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 3B",
    desc: "Best quality — slow on phones, fine on a laptop.",
    size: "~1.7 GB",
  },
]

const $ = (id) => document.getElementById(id)
const KEYS = {
  model: "anvil-local-model",
  chat: (id) => `anvil-local-chat-${id}`,
}
const MAX_CONTEXT_MSGS = 24 // small context window on purpose

let engine = null
let engineModel = null
let loading = false
let aborter = null

// ---------------------------------------------------------------- models

function modelListHtml() {
  const saved = localStorage.getItem(KEYS.model)
  return MODELS.map(
    (m, i) => `
      <label class="lc-model">
        <input type="radio" name="lc-model" value="${m.id}" ${m.id === saved ? "checked" : i === 0 ? "checked" : ""}>
        <span>
          <span class="lc-mname">${m.name}</span>
          <span class="lc-mdesc">${m.desc}</span>
        </span>
        <span class="lc-msize">${m.size}</span>
      </label>`,
  ).join("")
}

function selectedModel() {
  const id = document.querySelector('input[name="lc-model"]:checked')?.value
  return MODELS.find((m) => m.id === id) ?? MODELS[0]
}

async function checkWebGPU() {
  if (!navigator.gpu) {
    const el = $("lc-nowebgpu")
    el.textContent =
      "This browser does not support WebGPU, so the offline model cannot run here. " +
      "Use a recent Chrome/Edge (desktop or Android) or Safari 26 / iOS 26+. " +
      "Meanwhile, the regular anvil agent works fine via a server."
    el.hidden = false
    $("lc-load").disabled = true
    return false
  }
  try {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error("no adapter")
  } catch {
    const el = $("lc-nowebgpu")
    el.textContent = "WebGPU is available but no GPU adapter could be requested. Try a different browser or GPU settings."
    el.hidden = false
    $("lc-load").disabled = true
    return false
  }
  return true
}

async function loadModel() {
  if (loading) return
  const model = selectedModel()
  loading = true
  $("lc-load").disabled = true
  $("lc-load").textContent = "Loading…"
  $("lc-prog").hidden = false
  $("lc-prog-text").hidden = false
  $("lc-prog-text").textContent = "fetching engine…"
  try {
    const WebLLM = await import(WEBLLM_URL)
    engineModel = model.id
    $("lc-prog-text").textContent = "downloading model…"
    engine = await WebLLM.CreateMLCEngine(model.id, {
      initProgressCallback: (v) => {
        const pct = Math.round((v.progress ?? 0) * 100)
        document.querySelector("#lc-prog > div").style.width = `${pct}%`
        $("lc-prog-text").textContent = v.text ? `${pct}% · ${String(v.text).slice(0, 40)}` : `${pct}%`
      },
    })
    localStorage.setItem(KEYS.model, model.id)
    enterChat()
  } catch (err) {
    $("lc-sub").innerHTML = `Loading failed: <span class="mono">${escapeHtml(String(err).slice(0, 300))}</span><br>The first load needs an internet connection (model + runtime are cached afterwards).`
    $("lc-load").textContent = "Try again"
    loading = false
    $("lc-load").disabled = false
  }
}

async function forgetModel() {
  try {
    const keys = await caches.keys()
    for (const k of keys) {
      if (k.toLowerCase().startsWith("mlc")) await caches.delete(k)
    }
  } catch {
    // cache storage unavailable — nothing to forget
  }
  if (engine) {
    try {
      await engine.unload()
    } catch {
      // ignore
    }
    engine = null
  }
  localStorage.removeItem(KEYS.model)
  location.reload()
}

// ---------------------------------------------------------------- chat

function chatKey() {
  return KEYS.chat(engineModel)
}

function loadChat() {
  try {
    return JSON.parse(localStorage.getItem(chatKey()) ?? "[]")
  } catch {
    return []
  }
}

function saveChat(messages) {
  try {
    // keep the raw messages (role/content) — render state is not persisted
    localStorage.setItem(chatKey(), JSON.stringify(messages.slice(-200)))
  } catch {
    // storage full (long conversation) — drop the oldest
    try {
      localStorage.setItem(chatKey(), JSON.stringify(messages.slice(-40)))
    } catch {
      // give up quietly
    }
  }
}

function msgEl(role, html) {
  const div = document.createElement("div")
  div.className = `lc-msg ${role}`
  div.innerHTML = `<div class="lc-role">${role === "user" ? "You" : "Model"}</div><div class="lc-bubble"></div>`
  div.querySelector(".lc-bubble").innerHTML = html
  return div
}

function renderAll(messages) {
  const box = $("lc-messages")
  box.innerHTML = ""
  if (messages.length === 0) {
    box.appendChild(
      Object.assign(msgEl("assistant", escapeHtml("Hi! I'm the small offline model. No tools, no file access — but I can chat, brainstorm and draft."))),
    )
  }
  for (const m of messages) box.appendChild(msgEl(m.role, renderMarkdown(m.content)))
  box.scrollTop = box.scrollHeight
}

function enterChat() {
  $("lc-pick").hidden = true
  $("lc-chat").hidden = false
  $("lc-model-tag").textContent = engineModel
  $("lc-model-tag").hidden = false
  const messages = loadChat()
  renderAll(messages)
  $("lc-input").focus()
}

async function send() {
  const input = $("lc-input")
  const text = input.value.trim()
  if (!text || !engine || loading) return
  input.value = ""
  autosize(input)

  const messages = loadChat()
  messages.push({ role: "user", content: text })
  saveChat(messages)
  const box = $("lc-messages")
  box.appendChild(msgEl("user", renderMarkdown(text)))
  box.scrollTop = box.scrollHeight

  const bubble = msgEl("assistant", "")
  bubble.classList.add("streaming")
  box.appendChild(bubble)
  box.scrollTop = box.scrollHeight

  $("lc-send").disabled = true
  let acc = ""
  aborter = new AbortController()
  $("lc-send").textContent = "■"
  $("lc-send").title = "Stop"
  try {
    // Small context window: keep the system line + the last N messages.
    const ctx = messages.slice(-MAX_CONTEXT_MSGS)
    const stream = await engine.chat.completions.create(
      {
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant running fully offline on the user's device as a small language model. " +
              "Answer concisely. You have no tools and no internet access. If you are unsure, say so.",
          },
          ...ctx.map((m) => ({ role: m.role, content: m.content })),
        ],
        stream: true,
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 1024,
      },
      { signal: aborter.signal },
    )
    const bubbleEl = bubble.querySelector(".lc-bubble")
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content
      if (delta) {
        acc += delta
        bubbleEl.innerHTML = renderMarkdown(acc)
        box.scrollTop = box.scrollHeight
      }
    }
    if (!acc.trim()) acc = "(empty response)"
    messages.push({ role: "assistant", content: acc })
    saveChat(messages)
  } catch (err) {
    if (!acc) {
      bubble.querySelector(".lc-bubble").innerHTML = escapeHtml(
        String(err?.message ?? err).slice(0, 400),
      )
    }
    // keep whatever streamed so far
    if (acc) {
      messages.push({ role: "assistant", content: acc + (err ? " (stopped)" : "") })
      saveChat(messages)
    }
  } finally {
    bubble.classList.remove("streaming")
    aborter = null
    $("lc-send").disabled = false
    $("lc-send").textContent = "↑"
    $("lc-send").title = "Send"
    box.scrollTop = box.scrollHeight
  }
}

function autosize(ta) {
  ta.style.height = "auto"
  ta.style.height = Math.min(ta.scrollHeight, 140) + "px"
}

// ---------------------------------------------------------------- init

function init() {
  $("lc-models").innerHTML = modelListHtml()
  void checkWebGPU().then((ok) => {
    if (ok) {
      const saved = localStorage.getItem(KEYS.model)
      if (saved && MODELS.some((m) => m.id === saved)) {
        // A model id was used before: offer to jump straight in (the
        // download is usually cached already).
        $("lc-load").textContent = "Start (cached model)"
      }
    }
  })
  $("lc-load").addEventListener("click", () => void loadModel())
  $("lc-reset").addEventListener("click", () => void forgetModel())
  $("lc-send").addEventListener("click", () => void send())
  $("lc-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  })
  $("lc-input").addEventListener("input", (e) => autosize(e.target))
  $("lc-clear").addEventListener("click", () => {
    localStorage.removeItem(chatKey())
    renderAll([])
  })
  const back = document.querySelector(".lc-top a")
  if (new URLSearchParams(location.search).get("embedded") === "1" && back) {
    // inside the mobile app shell: no parent app to go back to
    back.style.display = "none"
  }
}

init()
