/**
 * Lynx Code — everything the person sees and decides in the browser, on top of
 * the relay in background.js (loaded after it, sharing its globals):
 *
 *   - pairing by itself: finds the app on its port and asks for the token;
 *   - the wire's version: reloads from disk when the app brought a newer one;
 *   - what the Lynx is doing: the icon's badge, desktop notifications, and the
 *     side panel, fed by the `status` messages the app sends;
 *   - asking without the app: side panel, the page's right-click menu, Alt+L;
 *   - control: Stop (button, Alt+Shift+L, Esc in the tab she drives), sites she
 *     may never touch, and sites she may only look at;
 *   - the tabs she opens, grouped in a "Lynx" tab group.
 */

/** Must match EXTENSION_PROTOCOL in packages/opencode/src/browser/bridge.ts. */
const PROTOCOL_VERSION = 4
/** Where the app listens: the saved port first, then its usual one, then the dev servers. */
const CANDIDATE_PORTS = [4919, 4096, 4097, 4920, 4921]
/** How often a browser told the Lynx is busy elsewhere asks again. */
const BUSY_RETRY = 30000
/** After Stop, the Lynx may not touch the browser for this long, so a step already sent cannot carry on. */
const HALT_MS = 8000
/** An Esc the Lynx sent herself arrives in the page this soon after; it is not the person's. */
const OWN_ESC_MS = 1500
/** A permission the app answers by itself (by mode) is gone within this; only one still waiting is notified. */
const ASK_SETTLE_MS = 1500
const BADGE = { coral: "#ff6b5b", deep: "#e5484d", amber: "#f59e0b", gray: "#6b7280" }

/** Sites the Lynx may never drive; the person edits the list in the popup. */
const DEFAULT_BLOCKED = [
  "bb.com.br",
  "itau.com.br",
  "bradesco.com.br",
  "santander.com.br",
  "caixa.gov.br",
  "nubank.com.br",
  "inter.co",
  "c6bank.com.br",
  "paypal.com",
  "mercadopago.com.br",
  "picpay.com",
]

const lynx = {
  /** The app's last word on what the Lynx is doing. */
  status: { phase: "idle" },
  /** The server's wire version, once it said. */
  serverProtocol: undefined,
  connectedSince: 0,
  lastError: "",
  haltedUntil: 0,
  lastOwnEsc: 0,
  /** The tab the Lynx last sent a command to. */
  agentTab: undefined,
  /** Last known URL per tab, so every command can be checked without asking the browser. */
  urls: new Map(),
  settings: { blocked: DEFAULT_BLOCKED, lookOnly: [], notify: true, group: true },
  blink: undefined,
  blinkOn: false,
  pairing: undefined,
  /** Set when a socket closed before the app welcomed it: the saved token is likely stale. */
  stale: false,
  /** Another browser is connected to the app; this one waits (see bridge.ts `claim`). */
  busyElsewhere: false,
  /** The person chose "Usar este navegador": the next pairing takes over. */
  takeOver: false,
}

void chrome.storage.local.get(["blocked", "lookOnly", "notify", "group"]).then((saved) => {
  if (Array.isArray(saved.blocked)) lynx.settings.blocked = saved.blocked
  if (Array.isArray(saved.lookOnly)) lynx.settings.lookOnly = saved.lookOnly
  if (typeof saved.notify === "boolean") lynx.settings.notify = saved.notify
  if (typeof saved.group === "boolean") lynx.settings.group = saved.group
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return
  for (const key of ["blocked", "lookOnly", "notify", "group"]) {
    if (changes[key]) lynx.settings[key] = changes[key].newValue ?? lynx.settings[key]
  }
})

// ── Pairing ──────────────────────────────────────────────────────────────────

/**
 * Finds the app and takes its token. The app hands it only to this extension's
 * own origin (the id is fixed by `key` in the manifest), so nothing has to be
 * pasted. Resolves whether it paired.
 */
function pair() {
  if (lynx.pairing) return lynx.pairing
  lynx.pairing = (async () => {
    const saved = (await chrome.storage.local.get("port")).port
    const ports = [...new Set([saved, ...CANDIDATE_PORTS].filter((port) => Number.isInteger(port)))]
    let outdated = false
    // Each search says what it found this time, not what an earlier one did.
    lynx.lastError = ""
    for (const port of ports) {
      // POST: the browser only names this extension as the Origin on a POST, and
      // the app hands the token to that origin alone.
      const answer = await fetch(`http://127.0.0.1:${port}/experimental/browser/extension/pair`, {
        method: "POST",
        signal: AbortSignal.timeout(1200),
        cache: "no-store",
      }).catch(() => undefined)
      if (!answer) continue
      if (answer.status === 409) {
        lynx.lastError = "O modo extensão está desligado no Lynx Code (Configurações → Navegador)."
        continue
      }
      const body = answer.ok ? await answer.json().catch(() => undefined) : undefined
      if (!body || typeof body.token !== "string" || !body.token) {
        // Something answers on the app's port but knows no pairing: an app from
        // before 0.9, which the panel cannot talk to until it is updated.
        if ([401, 404, 405].includes(answer.status) || answer.ok) outdated = true
        continue
      }
      lynx.stale = false
      lynx.lastError = ""
      await chrome.storage.local.set({ port, token: body.token })
      return true
    }
    if (outdated && !lynx.lastError)
      lynx.lastError = "O Lynx Code aberto neste computador está desatualizado para esta extensão. Atualize o app (botão Atualizar ou Reiniciar)."
    if (!lynx.lastError) lynx.lastError = "Não achei o Lynx Code aberto neste computador."
    return false
  })().finally(() => {
    lynx.pairing = undefined
  })
  return lynx.pairing
}

function onWelcome(message) {
  lynx.serverProtocol = message.protocol
  // The side panel's project, followed again on the new socket.
  if (lynx.watching) send({ type: "watch", directory: lynx.watching })
  lynx.connectedSince = Date.now()
  lynx.lastError = ""
  lynx.stale = false
  lynx.busyElsewhere = false
  lynx.takeOver = false
  if (typeof message.protocol !== "number" || message.protocol <= PROTOCOL_VERSION) return badge()
  // The app is newer: its update already put the new files where this was
  // loaded from, so a reload picks them up. Once in ten minutes at most, in
  // case the folder this runs from is not the app's.
  void chrome.storage.local.get("reloadedAt").then(({ reloadedAt }) => {
    if (typeof reloadedAt === "number" && Date.now() - reloadedAt < 10 * 60 * 1000) return
    void chrome.storage.local.set({ reloadedAt: Date.now() }).then(() => chrome.runtime.reload())
  })
}

/** Called by background.js when a socket ends; one that never got a welcome was most likely refused. */
function onSocketEnd(welcomed) {
  lynx.connectedSince = 0
  if (!welcomed && !lynx.busyElsewhere) lynx.stale = true
  badge()
  broadcast()
}

/** The app answered that another browser is using the Lynx. */
function onBusy() {
  lynx.busyElsewhere = true
  lynx.lastError = "Outro navegador está usando a Lynx agora."
  badge()
  broadcast()
}

// ── What the Lynx is doing ──────────────────────────────────────────────────

function onStatus(message) {
  const before = lynx.status
  lynx.status = message
  badge()
  broadcast()
  if (!lynx.settings.notify) return
  if (message.phase === "done" && before.phase !== "done") {
    notify("lynx-done", "A Lynx terminou", [message.session, tail(message.text)].filter(Boolean).join(" — "))
  }
  if (message.phase === "attention" && message.ask && before.ask?.id !== message.ask.id) {
    const id = message.ask.id
    setTimeout(() => {
      if (lynx.status.ask?.id !== id) return
      if (message.ask.kind === "permission") {
        notify(`lynx-ask:${id}`, "A Lynx pede permissão", message.ask.title, [
          { title: "Permitir uma vez" },
          { title: "Recusar" },
        ])
        return
      }
      notify("lynx-question", "A Lynx tem uma pergunta", `${message.ask.title} — responda no painel ou no app.`)
    }, ASK_SETTLE_MS)
  }
}

function tail(text) {
  if (!text) return ""
  const clean = String(text).replace(/\s+/g, " ").trim()
  return clean.length > 140 ? "…" + clean.slice(-140) : clean
}

function notify(id, title, message, buttons) {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message: message || " ",
    buttons,
    priority: buttons ? 2 : 0,
    requireInteraction: !!buttons,
  })
}

chrome.notifications.onButtonClicked.addListener((id, index) => {
  chrome.notifications.clear(id)
  if (!id.startsWith("lynx-ask:")) return
  send({ type: "answer", requestID: id.slice("lynx-ask:".length), reply: index === 0 ? "once" : "reject" })
})
chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id)
  void openPanel()
})

/** The icon: gray off, plain when paired, a blinking coral dot while she works, "!" when she waits, a check when done. */
function badge() {
  const online = !!socket && socket.readyState === WebSocket.OPEN
  const phase = lynx.status.phase
  clearInterval(lynx.blink)
  lynx.blink = undefined
  const title = !online
    ? "Lynx Code — desconectado"
    : phase === "working"
      ? `Lynx trabalhando${lynx.status.step ? ": " + lynx.status.step : ""}`
      : phase === "attention"
        ? `Lynx esperando você: ${lynx.status.ask?.title ?? ""}`
        : phase === "done"
          ? `Lynx terminou${lynx.status.session ? ": " + lynx.status.session : ""}`
          : "Lynx Code — conectado"
  void chrome.action.setTitle({ title })
  if (!online && lynx.busyElsewhere) return setBadge("…", BADGE.gray)
  if (!online) return setBadge("off", BADGE.gray)
  if (phase === "attention") return setBadge("!", BADGE.amber)
  if (phase === "done") return setBadge("✓", BADGE.deep)
  if (phase !== "working") return setBadge("", BADGE.coral)
  setBadge("●", BADGE.coral)
  lynx.blink = setInterval(() => {
    lynx.blinkOn = !lynx.blinkOn
    void chrome.action.setBadgeText({ text: lynx.blinkOn ? "●" : "" })
  }, 700)
}

function setBadge(text, color) {
  void chrome.action.setBadgeBackgroundColor({ color })
  void chrome.action.setBadgeText({ text })
  if (chrome.action.setBadgeTextColor) void chrome.action.setBadgeTextColor({ color: "#ffffff" })
}

/** Everything the popup and side panel show. */
function snapshot() {
  return {
    connected: !!socket && socket.readyState === WebSocket.OPEN,
    port: socketPort,
    since: lynx.connectedSince,
    lastError: lynx.lastError,
    protocol: PROTOCOL_VERSION,
    serverProtocol: lynx.serverProtocol,
    version: chrome.runtime.getManifest().version,
    status: lynx.status,
    agentTab: lynx.agentTab,
    busyElsewhere: lynx.busyElsewhere,
  }
}

function broadcast() {
  chrome.runtime.sendMessage({ type: "lynx-state", state: snapshot() }).catch(() => {})
}

// ── Asking ──────────────────────────────────────────────────────────────────

/** Sends a request to the app, with the tab it was made on unless `page` is false. */
async function ask({ text, page = true, follow = false, selection, tab }) {
  if (!text || !text.trim()) return false
  const where = page ? tab ?? (await activeTab()) : undefined
  const sent = sendIfOpen({
    type: "ask",
    text: text.trim(),
    follow,
    selection: selection || undefined,
    tab: where ? { targetId: String(where.id), url: where.url || "", title: where.title || "" } : undefined,
  })
  if (!sent) lynx.lastError = "O Lynx Code não está conectado; abra o app e tente de novo."
  broadcast()
  return sent
}

function sendIfOpen(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  send(message)
  return true
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab && /^https?:|^file:/.test(tab.url || "") ? tab : undefined
}

async function selectionOf(tabId) {
  if (typeof tabId !== "number") return ""
  return chrome.tabs.sendMessage(tabId, { type: "selection" }).catch(() => "")
}

async function openPanel(windowId) {
  const id = windowId ?? (await chrome.windows.getLastFocused().catch(() => undefined))?.id
  if (typeof id !== "number") return
  await chrome.sidePanel.open({ windowId: id }).catch(() => {})
}

// ── Stop and the safety lists ───────────────────────────────────────────────

/** Stops the Lynx: the app aborts her sessions, and the browser refuses her for a moment and lets go of her tabs. */
function stop(reason) {
  lynx.haltedUntil = Date.now() + HALT_MS
  send({ type: "stop", reason })
  for (const tabId of [...attached]) void detach(tabId).then(() => send({ type: "detached", targetId: String(tabId), reason: "stopped" }))
  broadcast()
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

function matches(url, list) {
  const host = hostOf(url)
  if (!host) return false
  return list.some((entry) => {
    const domain = String(entry).trim().toLowerCase().replace(/^\*\./, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "")
    return domain && (host === domain || host.endsWith("." + domain))
  })
}

const isBlocked = (url) => matches(url, lynx.settings.blocked)
const isLookOnly = (url) => matches(url, lynx.settings.lookOnly)

/** Commands that change a page: refused on a look-only site. */
const ACTS = /^Input\.|^DOM\.setFileInputFiles$/

/**
 * Called by background.js before it touches a tab for the Lynx. Throws a
 * message she can read and act on; the person's own browsing is never limited.
 */
function guard(type, message) {
  if (Date.now() < lynx.haltedUntil && type !== "listTargets" && type !== "detach")
    throw new Error("A pessoa parou a Lynx pela extensão. Não continue esta tarefa; espere um novo pedido.")
  if (type === "createTarget" && isBlocked(message.url || ""))
    throw new Error(`A pessoa bloqueou ${hostOf(message.url)} na extensão Lynx Code: a Lynx não pode abrir este site.`)
  if (type !== "attach" && type !== "command") return
  const tabId = Number(message.targetId)
  const url = lynx.urls.get(tabId) || ""
  if (isBlocked(url))
    throw new Error(`A pessoa bloqueou ${hostOf(url)} na extensão Lynx Code: a Lynx não pode mexer nesta aba.`)
  if (type !== "command") return
  if (message.method === "Page.navigate" && isBlocked(message.params?.url || ""))
    throw new Error(`A pessoa bloqueou ${hostOf(message.params.url)} na extensão Lynx Code: a Lynx não pode abrir este site.`)
  if (ACTS.test(message.method || "") && isLookOnly(url))
    throw new Error(`A pessoa marcou ${hostOf(url)} como "só olhar" na extensão Lynx Code: leia a página, mas não clique nem digite aqui.`)
  if (message.method === "Input.dispatchKeyEvent") {
    const params = message.params || {}
    if (params.key === "Escape" || params.code === "Escape" || params.windowsVirtualKeyCode === 27) lynx.lastOwnEsc = Date.now()
  }
  if (lynx.agentTab !== tabId) {
    lynx.agentTab = tabId
    broadcast()
  }
}

// ── The Lynx's tabs ─────────────────────────────────────────────────────────

const GROUPS = "lynxGroups"

/** Puts a tab the Lynx opened in the window's "Lynx" group, made on first use. */
async function groupAgentTab(tab) {
  if (!lynx.settings.group || typeof tab.id !== "number" || typeof tab.windowId !== "number") return
  const groups = (await chrome.storage.session.get(GROUPS))[GROUPS] || {}
  const known = groups[tab.windowId]
  const alive = typeof known === "number" ? await chrome.tabGroups.get(known).catch(() => undefined) : undefined
  const groupId = await chrome.tabs
    .group(alive ? { tabIds: [tab.id], groupId: alive.id } : { tabIds: [tab.id], createProperties: { windowId: tab.windowId } })
    .catch(() => undefined)
  if (typeof groupId !== "number") return
  if (!alive) {
    await chrome.tabGroups.update(groupId, { title: "Lynx", color: "red", collapsed: false }).catch(() => {})
    await chrome.storage.session.set({ [GROUPS]: { ...groups, [tab.windowId]: groupId } })
  }
}

// ── Tabs' addresses, for the safety lists ───────────────────────────────────

void chrome.tabs.query({}).then((tabs) => {
  for (const tab of tabs) if (typeof tab.id === "number") lynx.urls.set(tab.id, tab.url || "")
})
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const url = info.url || tab.url
  if (!url) return
  lynx.urls.set(tabId, url)
  // A page the Lynx drives went somewhere she may not be: let go of it.
  if (attached.has(tabId) && isBlocked(url))
    void detach(tabId).then(() => send({ type: "detached", targetId: String(tabId), reason: "blocked" }))
})
chrome.tabs.onRemoved.addListener((tabId) => {
  lynx.urls.delete(tabId)
  if (lynx.agentTab === tabId) lynx.agentTab = undefined
})

// ── Menu, shortcuts and messages ────────────────────────────────────────────

function menus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "lynx-explain", title: "Explicar com a Lynx: “%s”", contexts: ["selection"] })
    chrome.contextMenus.create({ id: "lynx-notebook", title: "Mandar pro caderno da Lynx", contexts: ["selection"] })
    chrome.contextMenus.create({ id: "lynx-summary", title: "Resumir esta página com a Lynx", contexts: ["page"] })
    chrome.contextMenus.create({ id: "lynx-here", title: "Lynx, faça isto aqui…", contexts: ["page", "selection"] })
    chrome.contextMenus.create({ id: "lynx-image", title: "Perguntar à Lynx sobre esta imagem", contexts: ["image"] })
  })
}
chrome.runtime.onInstalled.addListener(menus)
chrome.runtime.onStartup.addListener(menus)

const MENU_TEXT = {
  "lynx-explain": "Explique este trecho de um jeito simples.",
  "lynx-notebook": "Guarde este trecho no caderno, com a página de onde veio.",
  "lynx-summary": "Resuma esta página.",
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Opening the panel needs the click itself, so it comes before anything awaited.
  void openPanel(tab?.windowId)
  const selection = info.selectionText || ""
  if (info.menuItemId === "lynx-image") return void imageToPanel(info.srcUrl, tab)
  const text = MENU_TEXT[info.menuItemId]
  // The panel sends it in its own conversation; if it never opens, the app starts one.
  void handToPanel({ text, selection, tabId: tab?.id, send: !!text }).then((taken) => {
    if (!taken && text) void ask({ text, selection, tab })
  })
})

// ── The side panel's chat ───────────────────────────────────────────────────

/** Calls the app's API for the panel, through the paired socket (see PANEL_API in bridge.ts). */
const calls = new Map()
let nextCall = 1

function api(method, path, body) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve({ status: 0, body: { error: "offline" } })
  const rid = nextCall++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      calls.delete(rid)
      resolve({ status: 0, body: { error: "timeout" } })
    }, 60000)
    calls.set(rid, (answer) => {
      clearTimeout(timer)
      resolve(answer)
    })
    send({ type: "api", rid, method, path, body })
  })
}

/** Called by background.js for the answer to one of the panel's calls. */
function onApi(message) {
  const done = calls.get(message.rid)
  if (!done) return
  calls.delete(message.rid)
  done({ status: message.status, body: message.body })
}

/** Called by background.js for a server event about the panel's project. */
function onBus(message) {
  chrome.runtime.sendMessage({ type: "lynx-bus", payload: message.payload }).catch(() => {})
}

/** The answer to the panel's dictation (see transcribe.ts). */
function onTranscribed(message) {
  const done = calls.get(message.rid)
  if (!done) return
  calls.delete(message.rid)
  done(message.error ? { error: message.error } : { text: message.text || "" })
}

function transcribe(audio, mime) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve({ error: "O Lynx Code não está conectado." })
  const rid = nextCall++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      calls.delete(rid)
      resolve({ error: "A transcrição demorou demais." })
    }, 90000)
    calls.set(rid, (answer) => {
      clearTimeout(timer)
      resolve(answer)
    })
    send({ type: "transcribe", rid, audio, mime })
  })
}

/** Bytes as base64, in slices: a spread of a whole image overflows the call stack. */
function base64(bytes) {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/** "Perguntar à Lynx sobre esta imagem": the image goes to the panel as an attachment. */
async function imageToPanel(src, tab) {
  if (!src) return
  const response = await fetch(src).catch(() => undefined)
  if (!response?.ok) return void handToPanel({ send: false, note: "Não deu para pegar essa imagem." })
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > 15 * 1024 * 1024) return void handToPanel({ send: false, note: "A imagem passa de 15 MB." })
  const mime = response.headers.get("content-type")?.split(";")[0] || "image/png"
  const name = decodeURIComponent(new URL(src).pathname.split("/").pop() || "imagem").slice(0, 60)
  void handToPanel({
    send: false,
    tabId: tab?.id,
    attachments: [{ name, mime, url: `data:${mime};base64,${base64(bytes)}` }],
  })
}

/** Asks a tab's page script for its readable text (page.js). */
async function pageOf(tabId) {
  const tab = typeof tabId === "number" ? await chrome.tabs.get(tabId).catch(() => undefined) : await activeTab()
  if (!tab?.id || !/^https?:|^file:/.test(tab.url || "")) return undefined
  const read = await chrome.tabs.sendMessage(tab.id, { type: "page-text" }).catch(() => undefined)
  return { id: tab.id, url: tab.url, title: tab.title, text: read?.text || "" }
}

/** Lets the person drag a box on the page, then shoots the visible tab; the panel crops it. */
async function shootArea() {
  const tab = await activeTab()
  if (!tab?.id) return { error: "Abra uma página para tirar o print." }
  const rect = await chrome.tabs.sendMessage(tab.id, { type: "crop" }).catch(() => undefined)
  if (rect === undefined) return { error: "Recarregue a página para escolher uma área (a extensão ainda não está nela)." }
  if (!rect) return { cancelled: true }
  const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }).catch(() => undefined)
  if (!url) return { error: "Não deu para tirar o print desta aba." }
  return { url, rect, title: tab.title || tab.url }
}

const PANEL_QUEUE = "panelQueue"

/**
 * Leaves a request for the side panel (from the page's menu); resolves whether
 * an open panel took it within a few seconds.
 */
async function handToPanel(request) {
  await chrome.storage.session.set({ [PANEL_QUEUE]: { ...request, at: Date.now() } })
  chrome.runtime.sendMessage({ type: "lynx-queue" }).catch(() => {})
  for (let waited = 0; waited < 4000; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const left = (await chrome.storage.session.get(PANEL_QUEUE))[PANEL_QUEUE]
    if (!left) return true
  }
  await chrome.storage.session.remove(PANEL_QUEUE)
  return false
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-panel") return void openPanel(tab?.windowId)
  if (command === "stop-lynx") stop("shortcut")
})

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== "string") return false
  switch (message.type) {
    case "lynx-get":
      respond(snapshot())
      return false
    case "lynx-api":
      void api(message.method, message.path, message.body).then(respond)
      return true
    case "lynx-watch":
      lynx.watching = message.directory
      sendIfOpen({ type: "watch", directory: message.directory })
      return false
    case "lynx-transcribe":
      void transcribe(message.audio, message.mime).then(respond)
      return true
    case "lynx-page":
      void pageOf(message.tabId).then(respond)
      return true
    case "lynx-shot-area":
      void shootArea().then(respond)
      return true
    case "lynx-open-session":
      respond(sendIfOpen({ type: "open", sessionID: message.sessionID, directory: message.directory }))
      return false
    case "lynx-take-over":
      lynx.takeOver = true
      lynx.busyElsewhere = false
      reconnectNow()
      respond(true)
      return false
    case "lynx-shot":
      void (async () => {
        const tab = await activeTab()
        if (!tab) return respond(undefined)
        const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 }).catch(() => undefined)
        respond(url ? { url, title: tab.title || tab.url } : undefined)
      })()
      return true
    case "lynx-tab":
      void (async () => {
        const tab = await activeTab()
        respond(tab ? { id: tab.id, url: tab.url, title: tab.title, selection: await selectionOf(tab.id) } : undefined)
      })()
      return true
    case "lynx-take":
      void chrome.storage.session.get(PANEL_QUEUE).then(async (saved) => {
        const request = saved[PANEL_QUEUE]
        await chrome.storage.session.remove(PANEL_QUEUE)
        respond(request && Date.now() - request.at < 10000 ? request : undefined)
      })
      return true
    case "lynx-open-app":
      // The app registers opencode:// with Windows; the browser asks before opening it.
      void chrome.tabs.create({ url: "opencode://open" })
      return false
    case "lynx-defaults":
      respond(DEFAULT_BLOCKED)
      return false
    case "lynx-ask":
      void (async () => {
        const tab = message.page === false ? undefined : await activeTab()
        const selection = message.withSelection && tab ? await selectionOf(tab.id) : undefined
        respond(await ask({ text: message.text, page: message.page !== false, follow: message.follow, selection, tab }))
      })()
      return true
    case "lynx-stop":
      stop("panel")
      respond(true)
      return false
    case "lynx-answer":
      respond(sendIfOpen({ type: "answer", requestID: message.requestID, reply: message.reply }))
      return false
    case "lynx-seen":
      sendIfOpen({ type: "seen" })
      return false
    case "lynx-pair":
      void pair().then((ok) => {
        if (ok && !(socket && socket.readyState === WebSocket.OPEN)) reconnectNow()
        respond({ ok, error: lynx.lastError })
      })
      return true
    case "esc": {
      const tabId = sender.tab?.id
      const driving = typeof tabId === "number" && attached.has(tabId)
      if (driving && lynx.status.phase === "working" && Date.now() - lynx.lastOwnEsc > OWN_ESC_MS) stop("esc")
      return false
    }
  }
  return false
})

/** Drops the current socket, if any, and connects again with what is saved. */
function reconnectNow() {
  const old = socket
  socket = undefined
  socketPort = undefined
  clearInterval(pingTimer)
  try {
    old && old.close()
  } catch {}
  retry = RETRY_MIN
  attempt = 0
  connect()
}

// Clicking the icon keeps the popup (pairing and safety); the panel opens from
// the popup, the menu, Alt+L or a notification.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
badge()
