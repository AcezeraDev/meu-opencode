/**
 * The side panel: a small chat with the Lynx, laid out like Claude's. It talks
 * to the Lynx Code app through the service worker (lynx.js), which relays the
 * app's API and its live events over the paired socket. Conversations made here
 * are ordinary sessions of the app: they show there too.
 */

const $ = (id) => document.getElementById(id)
const SAVED = ["panelProject", "panelSession", "panelModel", "panelMode", "panelUseTab", "panelRecent"]
const MODES = [
  { id: "default", label: "Padrão", hint: "Segue a configuração do app" },
  { id: "manual", label: "Manual", hint: "Pergunta antes de editar ou rodar comandos" },
  { id: "accept-edits", label: "Aceitar edições", hint: "Edita sem perguntar" },
  { id: "plan", label: "Plano", hint: "Só planeja, não mexe em nada" },
  { id: "bypass", label: "Ignorar permissões", hint: "Faz tudo sem perguntar" },
]
const VARIANT_NAMES = { none: "Nenhum", low: "Baixo", medium: "Médio", high: "Alto", minimal: "Mínimo", max: "Máximo", xhigh: "Muito alto" }

/** Catalogs that resell other companies' models: slower and pricier than the original's own API. */
const RESELLERS = { "nano-gpt": "NanoGPT", roteia: "Roteia", openrouter: "OpenRouter", requesty: "Requesty" }
const resellerOf = (provider) => RESELLERS[provider.id] ?? (provider.models.length > 150 ? provider.name : undefined)

/** Ready-made requests for the school sites the Lynx is used on most. */
const LESSON_CHIPS = [
  { label: "Responder esta lição", text: "Responda esta lição nesta aba, conferindo antes de enviar." },
  { label: "Resumir a aula", text: "Resuma esta aula em tópicos curtos, com o que é mais importante saber." },
  { label: "Explicar esta questão", text: "Explique a questão que está na tela, passo a passo, sem responder por mim." },
]
const SITES = [
  { name: "Moodle", test: (url) => /moodle|\/mod\/(quiz|assign|page|lesson|h5pactivity|forum|resource)\/|\/course\/view\.php/i.test(url), chips: LESSON_CHIPS },
  { name: "Sala do Futuro", test: (url) => /saladofuturo|educacao\.sp\.gov\.br|edusp/i.test(url), chips: LESSON_CHIPS },
  {
    name: "Google Sala de Aula",
    test: (url) => /classroom\.google\.com/i.test(url),
    chips: [{ label: "Resumir a atividade", text: "Resuma esta atividade: o que pede, o prazo e como entregar." }],
  },
]

/** Text for matching: "GPT-6.1 Sol", "gpt-6.1-sol" and "gpt 6.1 sol" all read the same. */
const words = (text) => String(text || "").toLowerCase().replace(/[-_./:()]+/g, " ").replace(/\s+/g, " ").trim()

const state = {
  connected: false,
  directory: undefined,
  projects: [],
  sessions: [],
  sessionID: undefined,
  /** messageID → { info, parts: Map(partID → part) } */
  messages: new Map(),
  busy: false,
  asks: new Map(),
  providers: [],
  model: undefined,
  /** Models chosen here lately, newest first, with the app's default. */
  recent: [],
  mode: "default",
  useTab: true,
  attachments: [],
  /** The app's skills, fetched the first time the picker opens. */
  skills: undefined,
  skillActive: 0,
  sending: false,
  error: "",
  /** Pages already sent as text in a conversation ("session|url"), so a page goes once. */
  sentPages: new Set(),
  /** The last message being edited: its id, reverted to when the edit is sent. */
  editing: undefined,
  /** Other tabs mentioned with @ for the next message. */
  mentions: [],
  tabActive: 0,
  /** Messages written while the app was away, sent when it comes back. */
  outbox: [],
  /** Steps and thoughts the person opened, kept open across redraws. */
  openParts: new Set(),
  /** Dollars to reais, for the conversation's cost. */
  rate: undefined,
  busyElsewhere: false,
  /** The tab in front, for the site's ready-made requests. */
  activeTab: undefined,
}

// ── Talking to the app ──────────────────────────────────────────────────────

async function api(method, path, body) {
  const answer = await chrome.runtime.sendMessage({ type: "lynx-api", method, path, body }).catch(() => undefined)
  if (!answer || answer.status === 0) throw new Error("O Lynx Code não respondeu.")
  if (answer.status >= 400) throw new Error(answer.body?.error || answer.body?.message || `Erro ${answer.status}`)
  return answer.body
}

const q = (path, extra = {}) => {
  const params = new URLSearchParams({ directory: state.directory || "", ...extra })
  return `${path}?${params}`
}

function toast(text) {
  const box = $("toast")
  box.textContent = text
  box.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (box.hidden = true), 3500)
}

// ── Start ───────────────────────────────────────────────────────────────────

async function boot() {
  const saved = await chrome.storage.local.get(SAVED)
  state.mode = saved.panelMode || "default"
  state.useTab = saved.panelUseTab !== false
  state.model = saved.panelModel
  state.recent = saved.panelRecent || []
  $("useTab").checked = state.useTab
  state.outbox = (await chrome.storage.local.get("panelOutbox")).panelOutbox || []
  void refreshActiveTab()
  void loadRate()
  const status = await chrome.runtime.sendMessage({ type: "lynx-get" }).catch(() => undefined)
  showConnection(status)
  if (!state.connected) return
  await loadProjects(saved.panelProject)
  await Promise.all([loadModels(), loadSessions()])
  // Until a model is picked here, the panel uses what the app used last: the
  // newest conversation's model and effort, then the config's default.
  if (!state.model) {
    const used = state.sessions.find((session) => session.model?.providerID && session.model?.id)?.model
    const variant = used?.variant && used.variant !== "default" ? used.variant : undefined
    state.model = used ? { providerID: used.providerID, modelID: used.id, variant } : state.appModel
    renderModel()
  }
  const last = saved.panelSession?.[state.directory]
  if (last && state.sessions.some((session) => session.id === last)) await openSession(last)
  else render()
  void takeQueued()
  void flushOutbox()
}

/** The worker's word on the connection; coming back online loads everything again. */
function setConnected(status) {
  const back = !!status?.connected && !state.connected
  showConnection(status)
  if (back) void boot()
}

function showConnection(status) {
  state.connected = !!status?.connected
  state.busyElsewhere = !state.connected && !!status?.busyElsewhere
  $("offline").hidden = state.connected
  $("takeOver").hidden = !state.busyElsewhere
  $("openApp").hidden = state.busyElsewhere
  $("offlineTitle").textContent = state.busyElsewhere ? "Outro navegador está usando a Lynx" : "O Lynx Code não está aberto"
  if (state.busyElsewhere)
    $("offlineText").textContent = "A Lynx só dirige um navegador por vez. Este espera e entra sozinho quando o outro sair, ou passe a usar este agora."
  else if (!state.connected && status?.lastError) $("offlineText").textContent = status.lastError
  render()
}

async function loadProjects(preferred) {
  const projects = await api("GET", "/project").catch(() => [])
  state.projects = projects.filter((project) => project.worktree && project.worktree !== "/").sort((a, b) => b.time.updated - a.time.updated)
  state.directory = state.projects.some((project) => project.worktree === preferred) ? preferred : state.projects[0]?.worktree
  chrome.runtime.sendMessage({ type: "lynx-watch", directory: state.directory }).catch(() => {})
  const select = $("projectSelect")
  select.replaceChildren(
    ...state.projects.map((project) => {
      const option = document.createElement("option")
      option.value = project.worktree
      option.textContent = project.name || project.worktree.split(/[\\/]/).pop()
      option.selected = project.worktree === state.directory
      return option
    }),
  )
}

async function loadSessions() {
  if (!state.directory) return
  const search = $("sessionSearch").value.trim()
  const found = await api("GET", q("/session", { roots: "true", limit: search ? "40" : "30", ...(search ? { search } : {}) })).catch(() => [])
  found.sort((a, b) => b.time.updated - a.time.updated)
  // A search narrows the list shown, not the conversations the panel knows.
  if (!search) state.sessions = found
  else for (const session of found) if (!state.sessions.some((item) => item.id === session.id)) state.sessions.push(session)
  renderSessions(search ? found : state.sessions)
}

async function loadModels() {
  const [config, providers] = await Promise.all([
    api("GET", q("/config")).catch(() => ({})),
    api("GET", q("/config/providers")).catch(() => ({ providers: [] })),
  ])
  // Only what the menu needs, so the long catalog is not kept around whole.
  state.providers = (providers.providers || []).map((provider) => ({
    id: provider.id,
    name: provider.name || provider.id,
    models: Object.values(provider.models || {}).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      variants: Object.keys(model.variants || {}),
      image: model.capabilities?.input?.image !== false,
    })),
  }))
  if (typeof config.model === "string") {
    const [providerID, ...rest] = config.model.split("/")
    state.appModel = { providerID, modelID: rest.join("/") }
  }
  renderModel()
}

// ── Conversations ───────────────────────────────────────────────────────────

async function openSession(sessionID) {
  state.sessionID = sessionID
  state.messages = new Map()
  state.asks = new Map()
  state.error = ""
  const saved = (await chrome.storage.local.get("panelSession")).panelSession || {}
  await chrome.storage.local.set({ panelSession: { ...saved, [state.directory]: sessionID } })
  if (sessionID) {
    const [messages, status, permissions, questions] = await Promise.all([
      api("GET", q(`/session/${sessionID}/message`)).catch(() => []),
      api("GET", q("/session/status")).catch(() => ({})),
      api("GET", q("/permission")).catch(() => []),
      api("GET", q("/question")).catch(() => []),
    ])
    for (const message of messages) {
      state.messages.set(message.info.id, { info: message.info, parts: new Map(message.parts.map((part) => [part.id, part])) })
    }
    state.busy = !!status[sessionID] && status[sessionID].type !== "idle"
    const session = state.sessions.find((item) => item.id === sessionID)
    if (session) state.mode = session.metadata?.permissionMode || "default"
    for (const ask of permissions) if (ask.sessionID === sessionID) state.asks.set(ask.id, { kind: "permission", ...ask })
    for (const ask of questions) if (ask.sessionID === sessionID) state.asks.set(ask.id, { kind: "question", ...ask })
  }
  if (!sessionID) state.busy = false
  closeMenus()
  render(true)
}

function newConversation() {
  void openSession(undefined)
  $("text").focus()
}

// ── Sending ─────────────────────────────────────────────────────────────────

async function submit(textOverride, options = {}) {
  const typed = $("text").value.trim() || state.attachments.length
  if (state.busy && !textOverride && !typed) return stop()
  const text = (textOverride ?? $("text").value).trim()
  if ((!text && state.attachments.length === 0) || state.sending) return
  const outgoing = await compose(text, options)
  if (!textOverride) $("text").value = ""
  state.attachments = []
  state.mentions = []
  state.editing = undefined
  autosize()
  if (!state.connected || !state.directory) return queue(outgoing)
  await deliver(outgoing)
}

/**
 * Everything a message needs, gathered when it is written: the text, the
 * attachments, the page in front (as text, so the Lynx answers without opening
 * it) and any tabs mentioned with @. A message kept for later keeps all of it.
 */
async function compose(text, options) {
  const page = (id) => chrome.runtime.sendMessage({ type: "lynx-page", tabId: id }).catch(() => undefined)
  const tab = state.useTab || options.readPage ? await page() : undefined
  const mentioned = (await Promise.all(state.mentions.map((mention) => page(mention.id)))).filter(Boolean)
  return {
    text,
    selection: options.selection,
    readPage: !!options.readPage,
    tab,
    mentioned,
    attachments: [...state.attachments],
    editing: state.editing,
    sessionID: state.sessionID,
    parts: options.parts,
  }
}

async function deliver(out) {
  state.sending = true
  state.error = ""
  render(true)
  try {
    let sessionID = out.sessionID
    if (!sessionID) {
      const created = await api("POST", q("/session"), {})
      sessionID = created.id
      if (state.mode !== "default")
        await api("PATCH", q(`/session/${sessionID}`), { metadata: { permissionMode: state.mode } }).catch(() => undefined)
      await openSession(sessionID)
      void loadSessions()
    }
    // Editing or trying again: the conversation goes back to before that message first.
    if (out.editing) await api("POST", q(`/session/${sessionID}/revert`), { messageID: out.editing })
    const body = { parts: out.parts ?? partsOf(out, sessionID) }
    if (state.model) {
      body.model = { providerID: state.model.providerID, modelID: state.model.modelID }
      if (state.model.variant) body.variant = state.model.variant
    }
    await api("POST", q(`/session/${sessionID}/prompt_async`), body)
    state.busy = true
  } catch (error) {
    // The app went away mid-send: the message waits for it instead of being lost.
    if (!state.connected || /não respondeu/.test(error.message)) queue(out)
    else state.error = error.message
  } finally {
    state.sending = false
    render(true)
  }
}

function partsOf(out, sessionID) {
  const parts = [{ type: "text", text: out.text || "Veja o anexo." }]
  if (out.selection) parts.push({ type: "text", text: `Trecho selecionado na página:\n"""\n${out.selection}\n"""` })
  const tab = out.tab
  if (tab?.url) {
    const where = `(Mensagem enviada pelo painel da extensão no Brave, na aba "${tab.title || ""}" — ${tab.url}, id da aba ${tab.id}.`
    const key = `${sessionID}|${tab.url}`
    const withText = !!tab.text && (out.readPage || !state.sentPages.has(key))
    parts.push({
      type: "text",
      synthetic: true,
      text: withText
        ? `${where} O texto da página vai abaixo: responda com ele. Abra a página pelo navegador só para agir nela (clicar, preencher, rolar) ou se o texto não bastar.)\n"""\n${tab.text}\n"""`
        : `${where} O texto dessa página já foi mandado antes nesta conversa. Use o navegador só para agir nela ou se precisar ver de novo.)`,
    })
    if (withText) state.sentPages.add(key)
  }
  for (const page of out.mentioned || [])
    parts.push({
      type: "text",
      synthetic: true,
      text: `(Aba mencionada "@${page.title || page.url}" — ${page.url}, id da aba ${page.id}. Texto dela:)\n"""\n${page.text || "(sem texto legível)"}\n"""`,
    })
  for (const file of out.attachments) parts.push({ type: "file", mime: file.mime, filename: file.name, url: file.url })
  return parts
}

/** Keeps a message for when the app is back; it is saved, so closing the panel does not lose it. */
function queue(out) {
  state.outbox.push(out)
  void chrome.storage.local.set({ panelOutbox: state.outbox }).catch(() => undefined)
  toast("O Lynx Code está fora do ar. A mensagem sai sozinha quando ele voltar.")
  render()
}

async function flushOutbox() {
  while (state.connected && state.outbox.length && !state.sending) {
    const out = state.outbox.shift()
    void chrome.storage.local.set({ panelOutbox: state.outbox }).catch(() => undefined)
    await deliver(out)
  }
  render()
}

function lastOf(role) {
  return sortedMessages().filter((entry) => entry.info.role === role).at(-1)
}

/** "Tentar de novo": the last question goes again, as it was, from before the last answer. */
async function retry() {
  const user = lastOf("user")
  if (!user || state.busy) return
  const parts = [...user.parts.values()]
    .filter((part) => part.type === "text" || part.type === "file")
    .map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text, ...(part.synthetic ? { synthetic: true } : {}) }
        : { type: "file", mime: part.mime, filename: part.filename, url: part.url },
    )
  await deliver({ text: "", attachments: [], parts, editing: user.info.id, sessionID: state.sessionID })
}

/** "Editar": the last question comes back to the box; sending it replaces it and what followed. */
function edit() {
  const user = lastOf("user")
  if (!user || state.busy) return
  const parts = [...user.parts.values()]
  $("text").value = parts.filter((part) => part.type === "text" && !part.synthetic).map((part) => part.text).join("\n")
  state.attachments = parts
    .filter((part) => part.type === "file")
    .map((part) => ({
      name: part.filename || "anexo",
      mime: part.mime,
      url: part.url,
      ...(part.filename?.endsWith(SKILL_SUFFIX) ? { skill: part.filename.slice(0, -SKILL_SUFFIX.length) } : {}),
    }))
  state.editing = user.info.id
  autosize()
  $("text").focus()
  render()
}

function stop() {
  if (state.sessionID) void api("POST", q(`/session/${state.sessionID}/abort`)).catch((error) => toast(error.message))
}

async function answerPermission(id, reply) {
  await api("POST", q(`/permission/${id}/reply`), { reply }).catch((error) => toast(error.message))
}

async function answerQuestion(id, answers) {
  await api("POST", q(`/question/${id}/reply`), { answers }).catch((error) => toast(error.message))
}

/** A request left by the page's right-click menu, sent here as soon as the panel is up. */
async function takeQueued() {
  const request = await chrome.runtime.sendMessage({ type: "lynx-take" }).catch(() => undefined)
  if (!request) return
  if (request.note) toast(request.note)
  if (request.attachments?.length) {
    state.attachments.push(...request.attachments)
    if (currentModel()?.image === false) toast("O modelo escolhido não lê imagens; troque de modelo para ela ver a imagem.")
    render()
  }
  if (!request.send) {
    $("text").focus()
    if (request.selection) state.pendingSelection = request.selection
    return
  }
  if (!state.connected) return
  await openSession(undefined)
  await submit(request.text, { selection: request.selection })
}

// ── Live events ─────────────────────────────────────────────────────────────

function onBus(payload) {
  const type = payload?.type
  const props = payload?.properties || {}
  if (type === "session.updated" || type === "session.created") {
    const info = props.info
    if (!info) return
    const index = state.sessions.findIndex((session) => session.id === info.id)
    if (index >= 0) state.sessions[index] = info
    else if (!info.parentID) state.sessions.unshift(info)
    return render()
  }
  if (/^(permission|question)(\.v2)?\.(replied|rejected)$/.test(type)) {
    state.asks.delete(props.requestID ?? props.id)
    return render()
  }
  const about = props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID
  if (!about || about !== state.sessionID) return
  if (type === "session.status") {
    state.busy = props.status?.type !== "idle"
    return render()
  }
  if (type === "message.updated" && props.info) {
    const entry = state.messages.get(props.info.id) || { info: props.info, parts: new Map() }
    entry.info = props.info
    state.messages.set(props.info.id, entry)
    return render(true)
  }
  if (type === "message.removed" && props.messageID) {
    state.messages.delete(props.messageID)
    return render()
  }
  if (type === "message.part.updated" && props.part) {
    const part = props.part
    const entry = state.messages.get(part.messageID) || { info: { id: part.messageID, role: "assistant", time: { created: Date.now() } }, parts: new Map() }
    entry.parts.set(part.id, part)
    state.messages.set(part.messageID, entry)
    return render(true)
  }
  if (type === "message.part.delta" && props.partID && props.field === "text") {
    const entry = state.messages.get(props.messageID)
    const part = entry?.parts.get(props.partID)
    if (!part) return
    part.text = (part.text || "") + props.delta
    return render(true)
  }
  if (type === "message.part.removed" && props.partID) {
    state.messages.get(props.messageID)?.parts.delete(props.partID)
    return render()
  }
  if (/^permission(\.v2)?\.asked$/.test(type) && props.id) {
    state.asks.set(props.id, {
      kind: "permission",
      id: props.id,
      sessionID: props.sessionID,
      permission: props.permission ?? props.action,
      patterns: props.patterns ?? props.resources ?? [],
    })
    return render(true)
  }
  if (/^question(\.v2)?\.asked$/.test(type) && props.id) {
    state.asks.set(props.id, { kind: "question", ...props })
    return render(true)
  }
}

// ── Drawing ─────────────────────────────────────────────────────────────────

// Batched with a timer, not a frame: a panel the browser is not painting still
// has to keep up, so it is current the moment it shows.
let frame
let following = false
function render(follow) {
  following = following || !!follow
  if (frame) return
  frame = setTimeout(() => {
    frame = undefined
    const follow = following
    following = false
    const scroller = $("scroller")
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
    draw()
    if (follow && atBottom) scroller.scrollTop = scroller.scrollHeight
  }, 16)
}

/** The conversation in order, without what a "try again" or an edit took back. */
function sortedMessages() {
  const session = state.sessions.find((item) => item.id === state.sessionID)
  const cut = session?.revert?.messageID
  return [...state.messages.values()]
    .filter((entry) => !cut || entry.info.id < cut)
    .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
}

function draw() {
  const session = state.sessions.find((item) => item.id === state.sessionID)
  $("sessionTitle").textContent = plainTitle(session?.title) || "Nova conversa"
  drawCost(session)
  drawSiteChips()
  drawOutbox()
  $("editing").hidden = !state.editing
  const messages = sortedMessages()
  const lastUser = messages.filter((entry) => entry.info.role === "user").at(-1)
  const lastAssistant = messages.filter((entry) => entry.info.role === "assistant").at(-1)
  state.lastIDs = { user: lastUser?.info.id, assistant: lastAssistant?.info.id }
  $("empty").hidden = !state.connected || messages.length > 0 || state.sending
  const transcript = $("transcript")
  transcript.replaceChildren(...messages.flatMap(drawMessage))
  for (const ask of state.asks.values()) transcript.append(drawAsk(ask))
  if (state.connected && (state.busy || state.sending) && state.asks.size === 0) transcript.append(drawWorking(messages))
  if (state.error) {
    const line = document.createElement("div")
    line.className = "error-line"
    line.textContent = state.error
    transcript.append(line)
  }
  const send = $("sendButton")
  const typed = $("text").value.trim().length > 0 || state.attachments.length > 0
  send.toggleAttribute("data-stop", state.busy && !typed)
  send.disabled = !state.connected || (!typed && !state.busy) || state.sending
  send.title = state.busy && !typed ? "Parar" : "Enviar"
  drawChips()
  $("modeButton").dataset.mode = state.mode
  $("modeButton").title = `Modo: ${MODES.find((mode) => mode.id === state.mode)?.label}`
}

/** A title as text: models sometimes write Markdown into it. */
const plainTitle = (title) => (title || "").replace(/[*_`#]+/g, "").trim()

function drawMessage(entry) {
  const parts = [...entry.parts.values()]
  if (entry.info.role === "user") {
    const bubble = document.createElement("div")
    bubble.className = "user"
    const images = parts.filter((part) => part.type === "file" && part.mime?.startsWith("image/"))
    const skills = parts.filter((part) => part.type === "file" && part.filename?.endsWith(SKILL_SUFFIX))
    const files = parts.filter((part) => part.type === "file" && !part.mime?.startsWith("image/") && !part.filename?.endsWith(SKILL_SUFFIX))
    if (skills.length) {
      const row = document.createElement("div")
      row.className = "skills"
      for (const part of skills) {
        const tag = document.createElement("span")
        tag.textContent = `✦ ${part.filename.slice(0, -SKILL_SUFFIX.length)}`
        row.append(tag)
      }
      bubble.append(row)
    }
    if (images.length) {
      const thumbs = document.createElement("div")
      thumbs.className = "thumbs"
      for (const part of images) {
        const img = document.createElement("img")
        img.src = part.url
        img.alt = part.filename || "imagem"
        thumbs.append(img)
      }
      bubble.append(thumbs)
    }
    for (const part of files) {
      const line = document.createElement("div")
      line.className = "file"
      line.textContent = `📎 ${part.filename || "arquivo"}`
      bubble.append(line)
    }
    const text = parts.filter((part) => part.type === "text" && !part.synthetic).map((part) => part.text).join("\n")
    if (text) bubble.append(document.createTextNode(text))
    if (entry.info.id !== state.lastIDs?.user || state.busy) return [bubble]
    const wrap = document.createElement("div")
    wrap.className = "user-wrap"
    const actions = document.createElement("div")
    actions.className = "actions"
    actions.append(iconButton("Editar", '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', edit))
    wrap.append(bubble, actions)
    return [wrap]
  }
  const box = document.createElement("div")
  box.className = "assistant"
  let said = ""
  for (const part of parts) {
    if (part.type === "text" && part.text && !part.synthetic) {
      const prose = document.createElement("div")
      prose.className = "prose"
      prose.innerHTML = renderMarkdown(part.text)
      box.append(prose)
      said += (said ? "\n\n" : "") + part.text
    }
    if (part.type === "reasoning" && part.text?.trim()) {
      const thinking = disclosure(part.id, "thinking")
      thinking.summary.textContent = part.time?.end ? "Pensou" : "Pensando…"
      const body = document.createElement("div")
      body.className = "thinking-text"
      body.textContent = part.text.trim()
      thinking.details.append(body)
      box.append(thinking.details)
    }
    if (part.type === "tool") {
      const step = disclosure(part.id, "step")
      step.details.dataset.state = part.state?.status || "pending"
      const dot = document.createElement("i")
      dot.className = "dot"
      const label = document.createElement("span")
      label.textContent = part.state?.title || part.tool
      label.title = part.tool
      step.summary.append(dot, label)
      const input = part.state?.input && Object.keys(part.state.input).length ? JSON.stringify(part.state.input, null, 1) : ""
      const output = part.state?.error || part.state?.output || ""
      if (input) step.details.append(codeBlock("Entrada", input, 600))
      if (output) step.details.append(codeBlock(part.state?.error ? "Erro" : "Resultado", String(output), 2000))
      if (!input && !output) step.details.append(codeBlock("", "Ainda sem resultado.", 100))
      box.append(step.details)
    }
  }
  if (entry.info.error?.data?.message) {
    const line = document.createElement("div")
    line.className = "error-line"
    line.textContent = entry.info.error.data.message
    box.append(line)
  }
  if (said && entry.info.time?.completed) box.append(drawActions(said, entry.info.id === state.lastIDs?.assistant && !state.busy))
  return box.childNodes.length ? [box] : []
}

/** A step or a thought that opens on click and stays open while the answer keeps coming. */
function disclosure(id, className) {
  const details = document.createElement("details")
  details.className = className
  details.open = state.openParts.has(id)
  details.addEventListener("toggle", () => {
    if (details.open) state.openParts.add(id)
    else state.openParts.delete(id)
  })
  const summary = document.createElement("summary")
  details.append(summary)
  return { details, summary }
}

function codeBlock(title, text, limit) {
  const block = document.createElement("div")
  block.className = "io"
  if (title) {
    const label = document.createElement("div")
    label.className = "io-label"
    label.textContent = title
    block.append(label)
  }
  const pre = document.createElement("pre")
  pre.textContent = text.length > limit ? `${text.slice(0, limit)}…` : text
  block.append(pre)
  return block
}

function drawCost(session) {
  const cost = session?.cost
  const box = $("cost")
  box.hidden = !cost
  if (!cost) return
  const money = (value, currency) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency, maximumFractionDigits: value < 1 ? 3 : 2 }).format(value)
  box.textContent = state.rate ? money(cost * state.rate, "BRL") : money(cost, "USD")
  box.title = state.rate ? `Gasto desta conversa (${money(cost, "USD")})` : "Gasto desta conversa"
}

/** The day's dollar rate, cached for hours (the same free sources the app uses). */
async function loadRate() {
  const saved = (await chrome.storage.local.get("usdBrl")).usdBrl
  if (saved && Date.now() - saved.at < 6 * 3600 * 1000) {
    state.rate = saved.rate
    return render()
  }
  const sources = [
    ["https://economia.awesomeapi.com.br/json/last/USD-BRL", (body) => body?.USDBRL?.bid],
    ["https://open.er-api.com/v6/latest/USD", (body) => body?.rates?.BRL],
  ]
  for (const [url, pick] of sources) {
    const rate = await fetch(url, { signal: AbortSignal.timeout(8000) })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body) => Number(pick(body)))
      .catch(() => Number.NaN)
    if (!Number.isFinite(rate) || rate <= 0) continue
    state.rate = rate
    void chrome.storage.local.set({ usdBrl: { rate, at: Date.now() } })
    return render()
  }
}

/** Ready-made requests when the tab in front is a school site. */
function drawSiteChips() {
  const site = state.activeTab?.url ? SITES.find((item) => item.test(state.activeTab.url)) : undefined
  const row = $("siteChips")
  if (!site || !state.connected) return row.replaceChildren()
  if (row.dataset.site === site.name && row.childElementCount) return
  row.dataset.site = site.name
  const label = document.createElement("span")
  label.className = "faint"
  label.textContent = site.name
  row.replaceChildren(
    label,
    ...site.chips.map((chip) => {
      const button = document.createElement("button")
      button.textContent = chip.label
      button.addEventListener("click", () => submit(chip.text, { readPage: true }))
      return button
    }),
  )
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
  state.activeTab = tab && /^https?:/.test(tab.url || "") ? tab : undefined
  delete $("siteChips").dataset.site
  render()
}

function drawOutbox() {
  const box = $("outbox")
  box.hidden = state.outbox.length === 0
  box.replaceChildren(
    ...state.outbox.map((out, index) => {
      const row = document.createElement("div")
      row.className = "queued"
      const text = document.createElement("span")
      text.textContent = `Na fila: ${out.text || "anexo"}`
      const cancel = document.createElement("button")
      cancel.textContent = "✕"
      cancel.title = "Não mandar"
      cancel.addEventListener("click", () => {
        state.outbox.splice(index, 1)
        void chrome.storage.local.set({ panelOutbox: state.outbox }).catch(() => undefined)
        render()
      })
      row.append(text, cancel)
      return row
    }),
  )
}

function drawActions(text, last) {
  const row = document.createElement("div")
  row.className = "actions"
  if (last) row.append(iconButton("Tentar de novo", '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>', retry))
  const copy = iconButton("Copiar", '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', () => {
    void navigator.clipboard.writeText(text).then(() => toast("Copiado"))
  })
  const speak = iconButton("Ler em voz alta", '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>', () => {
    if (speechSynthesis.speaking) return speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text.replace(/[#*`_>]/g, ""))
    utterance.lang = "pt-BR"
    speechSynthesis.speak(utterance)
  })
  row.append(copy, speak)
  return row
}

function iconButton(label, paths, onClick) {
  const button = document.createElement("button")
  button.className = "icon"
  button.title = label
  button.setAttribute("aria-label", label)
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`
  button.addEventListener("click", onClick)
  return button
}

function drawWorking(messages) {
  const row = document.createElement("div")
  row.className = "working"
  row.innerHTML = '<span class="spark"><i></i><i></i><i></i></span>'
  const running = messages.flatMap((entry) => [...entry.parts.values()]).filter((part) => part.type === "tool" && part.state?.status === "running").at(-1)
  const label = document.createElement("span")
  const thinking = messages.flatMap((entry) => [...entry.parts.values()]).some((part) => part.type === "reasoning" && !part.time?.end)
  label.textContent = state.sending
    ? "Enviando…"
    : running?.state?.title
      ? `Trabalhando nisso · ${running.state.title}`
      : thinking
        ? "Pensando…"
        : "Trabalhando nisso"
  row.append(label)
  return row
}

function drawAsk(ask) {
  const card = document.createElement("div")
  card.className = "ask"
  const what = document.createElement("div")
  what.className = "what"
  const buttons = document.createElement("div")
  buttons.className = "row"
  if (ask.kind === "permission") {
    const where = (ask.patterns || []).slice(0, 3).join(", ")
    what.textContent = `A Lynx pede permissão para ${ask.permission || "continuar"}${where ? `: ${where}` : ""}`
    for (const [reply, label, primary] of [["once", "Permitir uma vez", true], ["always", "Sempre", false], ["reject", "Recusar", false]]) {
      const button = document.createElement("button")
      button.textContent = label
      if (primary) button.className = "primary"
      button.addEventListener("click", () => answerPermission(ask.id, reply))
      buttons.append(button)
    }
    card.append(what, buttons)
    return card
  }
  const question = ask.questions?.[0]
  what.textContent = question?.question || "A Lynx tem uma pergunta."
  card.append(what)
  for (const option of question?.options || []) {
    const button = document.createElement("button")
    button.textContent = option.label
    button.title = option.description || ""
    // One answer per question; when there are more questions, the rest are answered in the app.
    button.addEventListener("click", () => answerQuestion(ask.id, (ask.questions || []).map((_, index) => (index === 0 ? [option.label] : []))))
    buttons.append(button)
  }
  const skip = document.createElement("button")
  skip.textContent = "Pular"
  skip.addEventListener("click", () => api("POST", q(`/question/${ask.id}/reject`)).catch((error) => toast(error.message)))
  buttons.append(skip)
  card.append(buttons)
  return card
}

function drawChips() {
  const mentions = state.mentions.map((mention, index) => {
    const chip = document.createElement("div")
    chip.className = "chip mention"
    const name = document.createElement("span")
    name.textContent = `@ ${mention.title}`
    name.title = mention.url
    const remove = document.createElement("button")
    remove.textContent = "✕"
    remove.title = "Tirar"
    remove.addEventListener("click", () => {
      state.mentions.splice(index, 1)
      render()
    })
    chip.append(name, remove)
    return chip
  })
  $("chips").replaceChildren(
    ...mentions,
    ...state.attachments.map((file, index) => {
      const chip = document.createElement("div")
      chip.className = file.skill ? "chip skill" : "chip"
      if (file.mime.startsWith("image/")) {
        const img = document.createElement("img")
        img.src = file.url
        img.alt = ""
        chip.append(img)
      }
      const name = document.createElement("span")
      name.textContent = file.skill ? `✦ ${file.skill}` : file.name
      const remove = document.createElement("button")
      remove.textContent = "✕"
      remove.title = "Tirar"
      remove.addEventListener("click", () => {
        state.attachments.splice(index, 1)
        render()
      })
      chip.append(name, remove)
      return chip
    }),
  )
}

function renderSessions(list = state.sessions) {
  const when = (time) => {
    const minutes = Math.round((Date.now() - time) / 60000)
    if (minutes < 60) return `${Math.max(1, minutes)} min`
    if (minutes < 1440) return `${Math.round(minutes / 60)} h`
    return `${Math.round(minutes / 1440)} d`
  }
  if (!list.length) {
    const none = document.createElement("div")
    none.className = "none"
    none.textContent = $("sessionSearch").value.trim() ? "Nenhuma conversa com isso." : "Nenhuma conversa ainda."
    return $("sessionList").replaceChildren(none)
  }
  $("sessionList").replaceChildren(
    ...list.slice(0, 40).map((session) => {
      const row = document.createElement("div")
      row.className = "session-row"
      const button = document.createElement("button")
      button.setAttribute("role", "menuitem")
      button.setAttribute("aria-current", String(session.id === state.sessionID))
      const title = document.createElement("span")
      title.textContent = plainTitle(session.title) || "Sem título"
      const time = document.createElement("span")
      time.className = "when"
      time.textContent = when(session.time.updated)
      button.append(title, time)
      button.addEventListener("click", () => openSession(session.id))
      const rename = iconButton("Renomear", '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', () => renameSession(row, session))
      const remove = iconButton("Apagar", '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>', () => {
        // Two clicks: the first asks, the second deletes.
        if (!row.dataset.confirm) {
          row.dataset.confirm = "1"
          remove.title = "Clique de novo para apagar"
          setTimeout(() => delete row.dataset.confirm, 3000)
          return
        }
        void deleteSession(session)
      })
      remove.classList.add("danger")
      row.append(button, rename, remove)
      return row
    }),
  )
}

function renameSession(row, session) {
  const input = document.createElement("input")
  input.type = "text"
  input.value = plainTitle(session.title)
  input.className = "rename"
  row.replaceChildren(input)
  input.focus()
  input.select()
  const done = async (save) => {
    const title = input.value.trim()
    if (save && title && title !== session.title) {
      session.title = title
      await api("PATCH", q(`/session/${session.id}`), { title }).catch((error) => toast(error.message))
    }
    renderSessions()
    render()
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void done(true)
    if (event.key === "Escape") {
      event.stopPropagation()
      void done(false)
    }
  })
  input.addEventListener("blur", () => void done(true))
}

async function deleteSession(session) {
  await api("DELETE", q(`/session/${session.id}`)).catch((error) => toast(error.message))
  state.sessions = state.sessions.filter((item) => item.id !== session.id)
  if (session.id === state.sessionID) await openSession(undefined)
  renderSessions()
  render()
}

function renderModel() {
  const model = currentModel()
  $("modelName").textContent = model?.name?.replace(/\s*\(.*\)\s*$/, "") || state.model?.modelID || "Modelo"
  const provider = state.providers.find((item) => item.id === state.model?.providerID)
  const via = provider ? resellerOf(provider) : undefined
  const variant = state.model?.variant ? VARIANT_NAMES[state.model.variant] || state.model.variant : ""
  $("variantName").textContent = [variant, via && `via ${via}`].filter(Boolean).join(" · ")
  $("modelButton").title = via ? `Modelo (revendido pelo ${via}: costuma ser mais lento)` : "Modelo"
}

function currentModel() {
  if (!state.model) return
  return state.providers.find((provider) => provider.id === state.model.providerID)?.models.find((model) => model.id === state.model.modelID)
}

function drawModelMenu() {
  const search = words($("modelSearch").value)
  const terms = search ? search.split(" ") : []
  const joined = search.replace(/ /g, "")
  // 0: the query read as one word is in the name ("gpt 6" in GPT-6.1, not in GPT-5.6);
  // 1: every word is the start of a word; -1: no match.
  const rank = (model, provider) => {
    if (!terms.length) return 0
    if (words(`${model.name} ${model.id}`).replace(/ /g, "").includes(joined)) return 0
    const own = words(`${model.name} ${model.id} ${provider.name} ${provider.id}`).split(" ")
    return terms.every((term) => own.some((word) => word.startsWith(term))) ? 1 : -1
  }
  const list = $("modelList")
  const items = []
  const lookup = (pick) => {
    const provider = state.providers.find((item) => item.id === pick?.providerID)
    const model = provider?.models.find((item) => item.id === pick.modelID)
    return model && { provider, model }
  }
  const recent = [state.model, state.appModel, ...state.recent]
    .filter((pick, index, all) => pick && all.findIndex((other) => other && other.providerID === pick.providerID && other.modelID === pick.modelID) === index)
    .map(lookup)
    .filter(Boolean)
  if (!search && recent.length) {
    const group = document.createElement("div")
    group.className = "group"
    group.textContent = "Recentes"
    items.push(group, ...recent.map(({ provider, model }) => modelButton(provider, model)))
  }
  // Providers of their own models (OpenAI, Ollama…) before the catalogs that resell hundreds.
  for (const provider of [...state.providers].sort((a, b) => a.models.length - b.models.length)) {
    const models = provider.models
      .map((model) => ({ model, rank: rank(model, provider) }))
      .filter((item) => item.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((item) => item.model)
    if (!models.length) continue
    const group = document.createElement("div")
    group.className = "group"
    group.textContent = provider.name
    items.push(group)
    for (const model of models.slice(0, search ? 40 : 12)) items.push(modelButton(provider, model))
  }
  list.replaceChildren(...items)
  const variants = currentModel()?.variants || []
  $("variantLabel").hidden = variants.length === 0
  $("variantList").replaceChildren(
    ...["", ...variants].filter((value, index) => index > 0 || variants.length).map((variant) => {
      const button = document.createElement("button")
      button.textContent = variant ? VARIANT_NAMES[variant] || variant : "Padrão"
      button.setAttribute("aria-current", String((state.model?.variant || "") === variant))
      button.addEventListener("click", () => {
        state.model = { ...state.model, variant: variant || undefined }
        void chrome.storage.local.set({ panelModel: state.model })
        renderModel()
        drawModelMenu()
      })
      return button
    }),
  )
}

function modelButton(provider, model) {
  const button = document.createElement("button")
  button.setAttribute("role", "menuitem")
  button.setAttribute("aria-current", String(state.model?.providerID === provider.id && state.model?.modelID === model.id))
  button.textContent = model.name
  const via = resellerOf(provider)
  if (via) {
    const badge = document.createElement("span")
    badge.className = "via"
    badge.textContent = `via ${via}`
    badge.title = "Revendido: costuma demorar mais e custar mais que o modelo direto do fabricante."
    button.append(badge)
  }
  const id = document.createElement("small")
  id.textContent = `${provider.name} · ${model.id}`
  button.append(id)
  button.addEventListener("click", () => chooseModel({ providerID: provider.id, modelID: model.id }))
  return button
}

function chooseModel(model) {
  state.model = model
  state.recent = [model, ...state.recent.filter((item) => item.providerID !== model.providerID || item.modelID !== model.modelID)].slice(0, 6)
  void chrome.storage.local.set({ panelModel: model, panelRecent: state.recent })
  renderModel()
  drawModelMenu()
}

function drawModeMenu() {
  $("modeMenu").replaceChildren(
    ...MODES.map((mode) => {
      const button = document.createElement("button")
      button.setAttribute("role", "menuitem")
      button.setAttribute("aria-current", String(mode.id === state.mode))
      button.innerHTML = ""
      button.textContent = mode.label
      const hint = document.createElement("small")
      hint.style.display = "block"
      hint.style.color = "var(--faint)"
      hint.textContent = mode.hint
      button.append(hint)
      button.addEventListener("click", async () => {
        state.mode = mode.id
        void chrome.storage.local.set({ panelMode: mode.id })
        if (state.sessionID)
          await api("PATCH", q(`/session/${state.sessionID}`), { metadata: { permissionMode: mode.id } }).catch((error) => toast(error.message))
        closeMenus()
        render()
      })
      return button
    }),
  )
}

// ── Skills ──────────────────────────────────────────────────────────────────

/**
 * A skill goes with the message as a small text file, `name.skill`, holding
 * what the skill tool would have returned; the app's composer does the same
 * (app/src/components/prompt-input/skill-picker.tsx), so the model reads it the
 * same way from either place.
 */
const SKILL_SUFFIX = ".skill"

function skillText(skill) {
  const dir = skill.location === "<built-in>" ? undefined : skill.location.replace(/[\\/][^\\/]*$/, "")
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    "The user attached this skill to their message. Follow its instructions for this request.",
    "",
    skill.content.trim(),
    ...(dir
      ? [
          "",
          `Base directory for this skill: ${dir}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
        ]
      : []),
    "</skill_content>",
  ].join("\n")
}

function dataUrlOf(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return `data:text/plain;base64,${btoa(binary)}`
}

async function openSkills(query, fromSlash) {
  const menu = $("skillMenu")
  if (menu.hidden) {
    closeMenus("skillMenu")
    menu.hidden = false
  }
  if (fromSlash) menu.dataset.slash = "1"
  else delete menu.dataset.slash
  $("skillSearch").hidden = !!fromSlash
  if (!fromSlash) $("skillSearch").value = query
  state.skillQuery = query
  if (!fromSlash) setTimeout(() => $("skillSearch").focus(), 0)
  if (!state.skills) {
    $("skillList").innerHTML = '<div class="none">Carregando as skills…</div>'
    state.skills = await api("GET", q("/skill")).catch((error) => {
      toast(error.message)
      return undefined
    })
  }
  drawSkillMenu()
}

function filteredSkills() {
  const query = ($("skillMenu").dataset.slash ? state.skillQuery || "" : $("skillSearch").value).trim().toLowerCase()
  const rank = (skill) => {
    const name = skill.name.toLowerCase()
    if (!query) return 1
    if (name.startsWith(query)) return 0
    if (name.includes(query)) return 1
    if (skill.description?.toLowerCase().includes(query)) return 2
    return -1
  }
  return [...(state.skills || [])]
    .map((skill) => ({ skill, rank: rank(skill) }))
    .filter((item) => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
    .map((item) => item.skill)
}

function drawSkillMenu() {
  if ($("skillMenu").hidden) return
  const list = filteredSkills()
  state.skillActive = Math.max(0, Math.min(state.skillActive, list.length - 1))
  const attached = new Set(state.attachments.filter((file) => file.skill).map((file) => file.skill))
  if (!list.length) {
    $("skillList").innerHTML = `<div class="none">${state.skills ? "Nenhuma skill com esse nome." : "Não deu para carregar as skills."}</div>`
    return
  }
  $("skillList").replaceChildren(
    ...list.slice(0, 80).map((skill, index) => {
      const button = document.createElement("button")
      button.setAttribute("role", "menuitemcheckbox")
      button.setAttribute("aria-checked", String(attached.has(skill.name)))
      if (index === state.skillActive) button.setAttribute("data-active", "")
      const check = document.createElement("span")
      check.className = "check"
      check.textContent = attached.has(skill.name) ? "✓" : ""
      const name = document.createElement("span")
      name.textContent = skill.name
      const description = document.createElement("small")
      description.textContent = skill.description || ""
      description.title = skill.description || ""
      button.append(check, name, description)
      button.addEventListener("click", () => {
        toggleSkill(skill)
        if ($("skillMenu").dataset.slash) {
          $("text").value = ""
          closeMenus()
          $("text").focus()
        }
      })
      return button
    }),
  )
  $("skillList").querySelector("[data-active]")?.scrollIntoView({ block: "nearest" })
}

function toggleSkill(skill) {
  const index = state.attachments.findIndex((file) => file.skill === skill.name)
  if (index >= 0) state.attachments.splice(index, 1)
  else state.attachments.push({ skill: skill.name, name: `${skill.name}${SKILL_SUFFIX}`, mime: "text/plain", url: dataUrlOf(skillText(skill)) })
  drawSkillMenu()
  render()
}

// ── Attachments and dictation ───────────────────────────────────────────────

function readFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name || "colado.png", mime: file.type || "application/octet-stream", url: reader.result })
    reader.onerror = () => resolve(undefined)
    reader.readAsDataURL(file)
  })
}

async function addFiles(files) {
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) {
      toast(`${file.name} passa de 20 MB`)
      continue
    }
    const read = await readFile(file)
    if (read) state.attachments.push(read)
  }
  if (state.attachments.some((file) => file.mime.startsWith("image/")) && currentModel()?.image === false)
    toast("O modelo escolhido não lê imagens; troque de modelo para ela ver o anexo.")
  render()
}

async function addFromMenu(kind) {
  closeMenus()
  if (kind === "file") return $("fileInput").click()
  if (kind === "skills") return openSkills("")
  if (kind === "mention") return openTabs("", false)
  if (kind === "area") {
    toast("Arraste na página para escolher a área (Esc cancela).")
    const shot = await chrome.runtime.sendMessage({ type: "lynx-shot-area" }).catch(() => undefined)
    if (!shot || shot.cancelled) return
    if (shot.error) return toast(shot.error)
    const url = await cropImage(shot.url, shot.rect).catch(() => undefined)
    if (!url) return toast("Não deu para recortar o print.")
    state.attachments.push({ name: `recorte — ${shot.title}`.slice(0, 80), mime: "image/png", url })
    if (currentModel()?.image === false) toast("O modelo escolhido não lê imagens; troque de modelo para ela ver o print.")
    return render()
  }
  if (kind === "shot") {
    const shot = await chrome.runtime.sendMessage({ type: "lynx-shot" }).catch(() => undefined)
    if (!shot) return toast("Não deu para tirar o print desta aba.")
    state.attachments.push({ name: `print — ${shot.title}`.slice(0, 80), mime: "image/jpeg", url: shot.url })
    if (currentModel()?.image === false) toast("O modelo escolhido não lê imagens; troque de modelo para ela ver o print.")
    return render()
  }
  if (kind === "selection") {
    const tab = await chrome.runtime.sendMessage({ type: "lynx-tab" }).catch(() => undefined)
    if (!tab?.selection) return toast("Selecione um texto na página primeiro.")
    const box = $("text")
    box.value = `${box.value}${box.value ? "\n\n" : ""}"${tab.selection}"\n\n`
    autosize()
    box.focus()
    render()
  }
}

/** Cuts the box the person dragged out of a shot of the visible tab. */
async function cropImage(url, rect) {
  const image = new Image()
  image.src = url
  await image.decode()
  const scale = image.naturalWidth / (rect.viewport || image.naturalWidth / rect.dpr)
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(rect.width * scale)
  canvas.height = Math.round(rect.height * scale)
  canvas.getContext("2d").drawImage(image, rect.x * scale, rect.y * scale, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL("image/png")
}

// ── Mentioning tabs ─────────────────────────────────────────────────────────

/** The open web pages, matching what follows the @. */
async function openTabs(query, fromAt) {
  const menu = $("tabMenu")
  closeMenus("tabMenu")
  menu.hidden = false
  if (fromAt) menu.dataset.at = "1"
  else delete menu.dataset.at
  const tabs = await chrome.tabs.query({}).catch(() => [])
  const terms = words(query).split(" ").filter(Boolean)
  state.tabChoices = tabs
    .filter((tab) => /^https?:/.test(tab.url || ""))
    .filter((tab) => terms.every((term) => words(`${tab.title} ${tab.url}`).includes(term)))
    .slice(0, 30)
  state.tabActive = 0
  drawTabMenu()
}

function drawTabMenu() {
  const list = state.tabChoices || []
  state.tabActive = Math.max(0, Math.min(state.tabActive, list.length - 1))
  if (!list.length) {
    $("tabList").innerHTML = '<div class="none">Nenhuma aba aberta com isso.</div>'
    return
  }
  $("tabList").replaceChildren(
    ...list.map((tab, index) => {
      const button = document.createElement("button")
      button.setAttribute("role", "menuitem")
      if (index === state.tabActive) button.setAttribute("data-active", "")
      const check = document.createElement("span")
      check.className = "check"
      check.textContent = state.mentions.some((mention) => mention.id === tab.id) ? "✓" : "@"
      const title = document.createElement("span")
      title.textContent = tab.title || tab.url
      const host = document.createElement("small")
      host.textContent = (() => {
        try {
          return new URL(tab.url).hostname
        } catch {
          return tab.url
        }
      })()
      button.append(check, title, host)
      button.addEventListener("click", () => mention(tab))
      return button
    }),
  )
  $("tabList").querySelector("[data-active]")?.scrollIntoView({ block: "nearest" })
}

/** Adds a tab to the next message; typed "@algo" becomes "@Título" in the text. */
function mention(tab) {
  const title = (tab.title || tab.url).slice(0, 40)
  if (!state.mentions.some((item) => item.id === tab.id)) state.mentions.push({ id: tab.id, title, url: tab.url })
  const box = $("text")
  if ($("tabMenu").dataset.at) {
    const before = box.value.slice(0, box.selectionStart).replace(/@[^\s@]*$/, `@${title} `)
    box.value = before + box.value.slice(box.selectionStart)
    box.selectionStart = box.selectionEnd = before.length
  }
  closeMenus()
  box.focus()
  autosize()
  render()
}

// ── Dictation ───────────────────────────────────────────────────────────────

/**
 * Records the person and has the app transcribe it (Brave has no speech
 * service of its own). A side panel cannot show the microphone prompt, so the
 * first time a tab of the extension asks for it; after that the panel can.
 */
let recorder
async function dictate() {
  if (recorder) return recorder.stop()
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => undefined)
  if (!stream) {
    toast("Permita o microfone na aba que abriu e volte aqui.")
    return void chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") })
  }
  const chunks = []
  const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : ""
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  const limit = setTimeout(() => recorder?.stop(), 2 * 60 * 1000)
  recorder.addEventListener("dataavailable", (event) => chunks.push(event.data))
  recorder.addEventListener("stop", async () => {
    clearTimeout(limit)
    for (const track of stream.getTracks()) track.stop()
    const mime = (recorder.mimeType || "audio/webm").split(";")[0]
    recorder = undefined
    $("micButton").removeAttribute("data-on")
    const blob = new Blob(chunks, { type: mime })
    if (blob.size < 2000) return resetPlaceholder()
    $("text").placeholder = "Transcrevendo…"
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ""
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    const result = await chrome.runtime.sendMessage({ type: "lynx-transcribe", audio: btoa(binary), mime }).catch(() => undefined)
    resetPlaceholder()
    if (!result || result.error) return toast(result?.error || "Não deu para transcrever.")
    const box = $("text")
    box.value = `${box.value}${box.value && !box.value.endsWith(" ") ? " " : ""}${result.text}`
    autosize()
    box.focus()
    render()
  })
  recorder.start()
  $("micButton").setAttribute("data-on", "")
  $("text").placeholder = "Gravando… clique no microfone para parar"
}

function resetPlaceholder() {
  $("text").placeholder = "Escreva uma mensagem…"
}

// ── Menus and wiring ────────────────────────────────────────────────────────

function closeMenus(except) {
  for (const id of ["sessionMenu", "moreMenu", "addMenu", "modeMenu", "modelMenu", "skillMenu", "tabMenu"]) if (id !== except) $(id).hidden = true
  $("sessionButton").setAttribute("aria-expanded", "false")
}

function toggle(id, before) {
  const menu = $(id)
  const opening = menu.hidden
  closeMenus(id)
  if (opening) before?.()
  menu.hidden = !opening
  return opening
}

function autosize() {
  const box = $("text")
  box.style.height = "auto"
  box.style.height = `${Math.min(box.scrollHeight, 200)}px`
}

$("sessionButton").addEventListener("click", (event) => {
  event.stopPropagation()
  const open = toggle("sessionMenu", () => void loadSessions())
  $("sessionButton").setAttribute("aria-expanded", String(open))
})
$("historyButton").addEventListener("click", (event) => {
  event.stopPropagation()
  toggle("sessionMenu", () => void loadSessions())
})
$("newButton").addEventListener("click", newConversation)
$("menuButton").addEventListener("click", (event) => {
  event.stopPropagation()
  toggle("moreMenu")
})
$("addButton").addEventListener("click", (event) => {
  event.stopPropagation()
  toggle("addMenu")
})
$("modeButton").addEventListener("click", (event) => {
  event.stopPropagation()
  toggle("modeMenu", drawModeMenu)
})
$("modelButton").addEventListener("click", (event) => {
  event.stopPropagation()
  if (toggle("modelMenu", drawModelMenu)) setTimeout(() => $("modelSearch").focus(), 0)
})
for (const id of ["sessionMenu", "moreMenu", "addMenu", "modeMenu", "modelMenu", "skillMenu", "tabMenu"])
  $(id).addEventListener("click", (event) => event.stopPropagation())
let searching
$("sessionSearch").addEventListener("input", () => {
  clearTimeout(searching)
  searching = setTimeout(() => void loadSessions(), 250)
})
$("cancelEdit").addEventListener("click", () => {
  state.editing = undefined
  state.attachments = []
  $("text").value = ""
  autosize()
  render()
})
$("takeOver").addEventListener("click", () => chrome.runtime.sendMessage({ type: "lynx-take-over" }))
chrome.tabs.onActivated.addListener(() => void refreshActiveTab())
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.url && tab.active) void refreshActiveTab()
})
document.addEventListener("click", () => closeMenus())
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus()
})

$("modelSearch").addEventListener("input", drawModelMenu)
$("projectSelect").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ panelProject: event.target.value })
  await loadProjects(event.target.value)
  await loadSessions()
  const saved = (await chrome.storage.local.get("panelSession")).panelSession || {}
  await openSession(saved[state.directory])
})
for (const button of document.querySelectorAll("[data-add]")) button.addEventListener("click", () => addFromMenu(button.dataset.add))
$("useTab").addEventListener("change", (event) => {
  state.useTab = event.target.checked
  void chrome.storage.local.set({ panelUseTab: state.useTab })
})
$("fileInput").addEventListener("change", (event) => {
  void addFiles([...event.target.files])
  event.target.value = ""
})
$("text").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files || [])]
  if (!files.length) return
  event.preventDefault()
  void addFiles(files)
})
$("composer").addEventListener("dragover", (event) => event.preventDefault())
$("composer").addEventListener("drop", (event) => {
  event.preventDefault()
  void addFiles([...(event.dataTransfer?.files || [])])
})
$("text").addEventListener("input", () => {
  autosize()
  // "/" at the start of an empty box opens the skills, filtered by what follows.
  const slash = $("text").value.match(/^\/(\S*)$/)
  // "@" starts a mention of another open tab.
  const at = $("text").value.slice(0, $("text").selectionStart).match(/(?:^|\s)@([^\s@]*)$/)
  if (slash) void openSkills(slash[1], true)
  else if (at) void openTabs(at[1], true)
  else if ((!$("skillMenu").hidden && $("skillMenu").dataset.slash) || (!$("tabMenu").hidden && $("tabMenu").dataset.at)) closeMenus()
  render()
})
$("text").addEventListener("keydown", (event) => {
  const tagging = !$("tabMenu").hidden && $("tabMenu").dataset.at
  if (tagging && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault()
    state.tabActive += event.key === "ArrowDown" ? 1 : -1
    return drawTabMenu()
  }
  if (tagging && event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    const tab = state.tabChoices?.[state.tabActive]
    return tab ? mention(tab) : closeMenus()
  }
  const picking = !$("skillMenu").hidden && $("skillMenu").dataset.slash
  if (picking && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault()
    state.skillActive += event.key === "ArrowDown" ? 1 : -1
    return drawSkillMenu()
  }
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (picking) {
    const skill = filteredSkills()[state.skillActive]
    if (skill) toggleSkill(skill)
    $("text").value = ""
    closeMenus()
    return render()
  }
  void submit()
})
$("skillSearch").addEventListener("input", () => {
  state.skillActive = 0
  drawSkillMenu()
})
$("skillSearch").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return
  event.preventDefault()
  const skill = filteredSkills()[state.skillActive]
  if (skill) toggleSkill(skill)
})
$("sendButton").addEventListener("click", () => {
  if (state.busy && !$("text").value.trim() && state.attachments.length === 0) return stop()
  void submit()
})
$("micButton").addEventListener("click", dictate)
for (const button of document.querySelectorAll("[data-suggest]"))
  button.addEventListener("click", async () => {
    const tab = button.dataset.selection ? await chrome.runtime.sendMessage({ type: "lynx-tab" }).catch(() => undefined) : undefined
    if (button.dataset.selection && !tab?.selection) return toast("Selecione um texto na página primeiro.")
    void submit(button.dataset.suggest, { selection: tab?.selection, readPage: !button.dataset.selection })
  })
$("openApp").addEventListener("click", () => chrome.runtime.sendMessage({ type: "lynx-open-app" }))
$("pairAgain").addEventListener("click", async () => {
  $("offlineText").textContent = "Procurando o Lynx Code…"
  const result = await chrome.runtime.sendMessage({ type: "lynx-pair" }).catch(() => undefined)
  if (!result?.ok) $("offlineText").textContent = result?.error || "Não achei o Lynx Code."
})
for (const button of document.querySelectorAll("[data-action]"))
  button.addEventListener("click", () => {
    closeMenus()
    const action = button.dataset.action
    if (action === "open-app") return chrome.runtime.sendMessage({ type: "lynx-open-app" })
    if (action === "open-session") {
      if (!state.sessionID) return toast("Abra ou comece uma conversa primeiro.")
      return chrome.runtime.sendMessage({ type: "lynx-open-session", sessionID: state.sessionID, directory: state.directory })
    }
    if (action === "stop") return chrome.runtime.sendMessage({ type: "lynx-stop" })
    if (action === "pair") return chrome.runtime.sendMessage({ type: "lynx-pair" }).then((result) => toast(result?.ok ? "Pareado" : result?.error || "Não achei o Lynx Code."))
    if (action === "settings") return chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") })
  })

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "lynx-state") setConnected(message.state)
  if (message?.type === "lynx-bus") onBus(message.payload)
  if (message?.type === "lynx-queue") void takeQueued()
  if (message?.type === "lynx-compose") $("text").focus()
})

void chrome.runtime.sendMessage({ type: "lynx-seen" })
void boot()
autosize()
$("text").focus()
