const $ = (id) => document.getElementById(id)
const PHASES = { off: "desconectado", idle: "conectado", working: "trabalhando", attention: "esperando você", done: "terminou" }

function ago(since) {
  if (!since) return "—"
  const minutes = Math.round((Date.now() - since) / 60000)
  if (minutes < 1) return "agora"
  if (minutes < 60) return `há ${minutes} min`
  return `há ${Math.round(minutes / 60)} h`
}

async function render() {
  const state = await chrome.runtime.sendMessage({ type: "lynx-get" }).catch(() => undefined)
  if (!state) return
  const phase = state.connected ? state.status?.phase ?? "idle" : "off"
  $("phase").dataset.phase = phase
  $("state").textContent = PHASES[phase] ?? phase
  $("port").textContent = state.port ?? "—"
  $("since").textContent = state.connected ? ago(state.since) : "—"
  $("version").textContent = `${state.version} · fio ${state.protocol}${state.serverProtocol ? ` (app ${state.serverProtocol})` : ""}`
  const tab = typeof state.agentTab === "number" ? await chrome.tabs.get(state.agentTab).catch(() => undefined) : undefined
  $("tab").textContent = tab ? tab.title || tab.url : "—"
  $("tab").title = tab?.url ?? ""
  $("warn").textContent =
    state.serverProtocol && state.serverProtocol < state.protocol
      ? "O app está mais velho que a extensão: clique em Atualizar no Lynx Code."
      : state.connected
        ? ""
        : state.lastError
  $("stop").disabled = phase !== "working" && phase !== "attention"
}

const lines = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

chrome.storage.local.get(["port", "token", "blocked", "lookOnly", "notify", "group"]).then((saved) => {
  if (saved.port) $("portInput").value = saved.port
  if (saved.token) $("token").value = saved.token
  $("blocked").value = (saved.blocked ?? []).join("\n")
  $("lookOnly").value = (saved.lookOnly ?? []).join("\n")
  $("notify").checked = saved.notify !== false
  $("group").checked = saved.group !== false
  if (!saved.blocked) chrome.runtime.sendMessage({ type: "lynx-defaults" }).then((list) => {
    if (Array.isArray(list)) $("blocked").value = list.join("\n")
  })
})

$("saveSafety").addEventListener("click", async () => {
  await chrome.storage.local.set({
    blocked: lines($("blocked").value),
    lookOnly: lines($("lookOnly").value),
    notify: $("notify").checked,
    group: $("group").checked,
  })
  $("saveSafety").textContent = "Salvo"
  setTimeout(() => ($("saveSafety").textContent = "Salvar"), 1500)
})

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ port: Number($("portInput").value) || 4919, token: $("token").value.trim() })
  render()
})

$("pair").addEventListener("click", async () => {
  $("pair").textContent = "Procurando o Lynx Code…"
  const result = await chrome.runtime.sendMessage({ type: "lynx-pair" }).catch(() => undefined)
  $("pair").textContent = result?.ok ? "Pareado" : "Parear de novo sozinho"
  if (!result?.ok) $("warn").textContent = result?.error || "Não achei o Lynx Code."
  setTimeout(render, 800)
})

// The panel must open within the click itself, so the window is looked up beforehand.
let windowId
chrome.windows.getCurrent().then((win) => (windowId = win.id))
$("panel").addEventListener("click", () => {
  if (typeof windowId !== "number") return
  chrome.sidePanel.open({ windowId }).then(() => window.close(), () => {})
})
$("stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "lynx-stop" }).then(render))

render()
setInterval(render, 1500)
