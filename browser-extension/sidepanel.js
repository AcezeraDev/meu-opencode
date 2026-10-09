/**
 * The side panel: what the Lynx is doing (her step, her answer as she writes
 * it, a permission she waits on) and a box to ask her something about the page
 * in front of you. The service worker (lynx.js) holds the connection; this only
 * shows its state and sends it requests.
 */

const $ = (id) => document.getElementById(id)
const PHASES = {
  off: "desconectada",
  idle: "pronta",
  working: "trabalhando",
  attention: "esperando você",
  done: "terminou",
}

function render(state) {
  if (!state) return
  const phase = state.connected ? state.status?.phase ?? "idle" : "off"
  document.body.toggleAttribute("data-offline", !state.connected)
  $("phase").dataset.phase = phase
  $("phaseText").textContent = PHASES[phase] ?? phase
  if (!state.connected) $("offlineText").textContent = state.lastError || "O Lynx Code não está conectado."

  const status = state.status ?? {}
  const busy = state.connected && (phase === "working" || phase === "attention" || phase === "done" || !!status.text)
  $("now").hidden = !busy
  $("session").textContent = status.session || "Lynx"
  $("step").textContent =
    phase === "working" ? (status.step ? `⏺ ${status.step}` : "pensando…") : phase === "done" ? "pronto" : ""
  $("stop").hidden = phase !== "working" && phase !== "attention"
  const answer = $("answer")
  const atBottom = answer.scrollHeight - answer.scrollTop - answer.clientHeight < 24
  answer.textContent = status.text || ""
  if (atBottom) answer.scrollTop = answer.scrollHeight

  const ask = phase === "attention" ? status.ask : undefined
  $("ask").hidden = !ask
  if (ask) {
    $("askTitle").textContent = ask.title
    $("askButtons").hidden = ask.kind !== "permission"
    $("askQuestion").hidden = ask.kind === "permission"
    $("ask").dataset.id = ask.id
  }
  $("send").disabled = !state.connected
}

async function send(text, options = {}) {
  if (!text.trim()) return
  $("note").textContent = "enviando…"
  const ok = await chrome.runtime
    .sendMessage({
      type: "lynx-ask",
      text,
      page: options.page ?? $("page").checked,
      follow: options.follow ?? $("follow").checked,
      withSelection: options.withSelection ?? $("withSelection").checked,
    })
    .catch(() => false)
  $("note").textContent = ok ? "enviado para o Lynx Code" : "não foi: o app está aberto?"
  if (ok) $("text").value = ""
  setTimeout(() => ($("note").textContent = ""), 4000)
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault()
  void send($("text").value)
})
$("text").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void send($("text").value)
})
for (const chip of document.querySelectorAll("[data-quick]")) {
  chip.addEventListener("click", () =>
    send(chip.dataset.quick, { page: true, follow: false, withSelection: chip.dataset.selection === "1" }),
  )
}
$("stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "lynx-stop" }))
for (const button of document.querySelectorAll("[data-reply]")) {
  button.addEventListener("click", () =>
    chrome.runtime.sendMessage({ type: "lynx-answer", requestID: $("ask").dataset.id, reply: button.dataset.reply }),
  )
}
$("pair").addEventListener("click", async () => {
  $("offlineText").textContent = "procurando…"
  const result = await chrome.runtime.sendMessage({ type: "lynx-pair" }).catch(() => undefined)
  if (!result?.ok) $("offlineText").textContent = result?.error || "Não achei o Lynx Code."
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "lynx-state") render(message.state)
  // "Lynx, faça isto aqui…" from the page's menu: ready to type, with the selection.
  if (message?.type === "lynx-compose") {
    $("page").checked = true
    $("withSelection").checked = !!message.selection
    $("text").focus()
  }
})

void chrome.runtime.sendMessage({ type: "lynx-get" }).then(render)
// Opening the panel is seeing a finished task.
void chrome.runtime.sendMessage({ type: "lynx-seen" })
$("text").focus()
