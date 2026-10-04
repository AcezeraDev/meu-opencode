import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } from "electron"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentTrayState } from "../preload/types"
import { write as writeLog } from "./logging"
import { appIconPath, getMainWindow } from "./windows"

/**
 * Ways to reach the agent without bringing the app forward first: a global
 * shortcut that opens a small box to ask something from anywhere in Windows,
 * an icon next to the clock that shows whether the agent is working, done, or
 * waiting (a click opens a bubble with the step it is on and a field to ask),
 * and a note in the corner, with a field to answer, when it needs the person.
 */

const SHORTCUT = "CommandOrControl+Shift+Space"
const SHORTCUT_LABEL = "Ctrl+Shift+Espaço"
const root = dirname(fileURLToPath(import.meta.url))

const DOT: Record<AgentTrayState["status"], [number, number, number] | undefined> = {
  idle: undefined,
  working: [34, 211, 238],
  done: [99, 102, 241],
  attention: [245, 158, 11],
}

let tray: Tray | undefined
let quick: BrowserWindow | undefined
let bubble: BrowserWindow | undefined
let note: BrowserWindow | undefined
let current: AgentTrayState = { status: "idle", tooltip: "Lynx Code" }
const icons = new Map<AgentTrayState["status"], Electron.NativeImage>()

export function setupAssistant() {
  ipcMain.handle("quick-ask-submit", (_event, text: unknown) => {
    if (typeof text !== "string" || !text.trim()) return
    closeQuick()
    closeBubble()
    const win = showMain()
    win?.webContents.send("quick-ask", text.trim())
  })
  ipcMain.handle("quick-ask-close", () => {
    closeQuick()
    closeBubble()
    closeNote()
  })
  ipcMain.handle("set-agent-tray", (_event, state: AgentTrayState) => updateTray(state))
  ipcMain.handle("lynx-dictate", () => dictate())
  ipcMain.handle("lynx-open-main", () => {
    closeBubble()
    closeNote()
    showMain()
  })
  // An answer typed in the corner note goes into the session that asked.
  ipcMain.handle("lynx-reply", (_event, text: unknown) => {
    closeNote()
    if (typeof text !== "string" || !text.trim()) return
    showMain()?.webContents.send("lynx-reply", text.trim())
  })

  if (process.platform === "win32") createTray()
  if (!globalShortcut.register(SHORTCUT, toggleQuick))
    writeLog("window", "global shortcut unavailable", { shortcut: SHORTCUT }, "warn")
  app.once("will-quit", () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
  })
}

function showMain() {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}

/**
 * Starts Windows voice typing (Win+H) in whatever field has the focus. Windows
 * has no API for it, so the key press is sent the way a keyboard would.
 */
function dictate() {
  if (process.platform !== "win32") return false
  const script = [
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class LynxKeys{[DllImport(\"user32.dll\")]public static extern void keybd_event(byte b,byte s,uint f,UIntPtr e);}'",
    "[LynxKeys]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)",
    "[LynxKeys]::keybd_event(0x48,0,0,[UIntPtr]::Zero)",
    "[LynxKeys]::keybd_event(0x48,0,2,[UIntPtr]::Zero)",
    "[LynxKeys]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)",
  ].join(";")
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
  })
  child.on("error", (error) => writeLog("window", "dictation failed", { error: String(error) }, "warn"))
  return true
}

function smallWindow(options: { width: number; height: number; x: number; y: number; title: string }) {
  return new BrowserWindow({
    ...options,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    focusable: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
}

function toggleQuick() {
  if (quick && !quick.isDestroyed()) {
    closeQuick()
    return
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = 660
  const height = 112
  quick = smallWindow({
    width,
    height,
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + display.workArea.height * 0.22),
    title: "Pergunta rápida",
  })
  quick.on("blur", () => closeQuick())
  quick.once("ready-to-show", () => {
    quick?.show()
    quick?.focus()
  })
  void quick.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(QUICK_PAGE)}`)
}

function closeQuick() {
  const win = quick
  quick = undefined
  if (win && !win.isDestroyed()) win.close()
}

/** The bubble above the tray icon: what Lynx is doing, a field to ask, and a way into the app. */
function toggleBubble() {
  if (bubble && !bubble.isDestroyed()) {
    closeBubble()
    return
  }
  const bounds = tray?.getBounds()
  const display = screen.getDisplayNearestPoint(bounds ? { x: bounds.x, y: bounds.y } : screen.getCursorScreenPoint())
  const width = 320
  const height = 214
  const x = Math.round(
    Math.min(
      display.workArea.x + display.workArea.width - width - 8,
      (bounds ? bounds.x + bounds.width / 2 : display.workArea.x + display.workArea.width) - width / 2,
    ),
  )
  bubble = smallWindow({
    width,
    height,
    x,
    y: display.workArea.y + display.workArea.height - height - 8,
    title: "Lynx",
  })
  bubble.on("blur", () => closeBubble())
  bubble.once("ready-to-show", () => {
    bubble?.show()
    bubble?.focus()
  })
  void bubble.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bubblePage(current))}`)
}

function closeBubble() {
  const win = bubble
  bubble = undefined
  if (win && !win.isDestroyed()) win.close()
}

/** A note in the corner when Lynx needs the person and the app is not in front, with a field to answer. */
function showNote(state: AgentTrayState) {
  const main = getMainWindow()
  if (main?.isFocused()) return
  closeNote()
  const display = screen.getPrimaryDisplay()
  const width = 340
  const height = 168
  note = smallWindow({
    width,
    height,
    x: display.workArea.x + display.workArea.width - width - 12,
    y: display.workArea.y + display.workArea.height - height - 12,
    title: "Lynx precisa de você",
  })
  note.once("ready-to-show", () => note?.showInactive())
  void note.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(notePage(state))}`)
  // Goes away by itself after a while; the tray dot keeps saying it.
  const shown = note
  setTimeout(() => {
    if (note === shown) closeNote()
  }, 45_000)
}

function closeNote() {
  const win = note
  note = undefined
  if (win && !win.isDestroyed()) win.close()
}

function createTray() {
  tray = new Tray(iconFor("idle"))
  tray.setToolTip(current.tooltip)
  tray.on("click", () => toggleBubble())
  tray.on("double-click", () => showMain())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir o Lynx Code", click: () => showMain() },
      { label: `Pergunta rápida (${SHORTCUT_LABEL})`, click: () => toggleQuick() },
      { type: "separator" },
      { label: "Sair", role: "quit" },
    ]),
  )
}

function updateTray(state: AgentTrayState) {
  if (!tray || tray.isDestroyed()) return
  if (state.status !== current.status) tray.setImage(iconFor(state.status))
  // Windows cuts tooltips at 127 characters.
  if (state.tooltip !== current.tooltip) tray.setToolTip(state.tooltip.slice(0, 127))
  if (state.status === "attention" && current.status !== "attention") showNote(state)
  if (state.status !== "attention") closeNote()
  current = state
}

/** The app's icon with a coloured dot in the corner for the agent's state. */
function iconFor(status: AgentTrayState["status"]) {
  const cached = icons.get(status)
  if (cached) return cached
  const size = 32
  const base = nativeImage.createFromPath(appIconPath()).resize({ width: size, height: size, quality: "best" })
  const color = DOT[status]
  if (!color || base.isEmpty()) {
    icons.set(status, base)
    return base
  }
  const pixels = Buffer.from(base.toBitmap())
  const center = size - 8.5
  const radius = 8
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center)
      if (distance > radius + 1.5) continue
      const offset = (y * size + x) * 4
      // A dark ring around the dot keeps it readable on light and dark taskbars.
      const [r, g, b] = distance > radius - 0.5 ? [11, 18, 38] : color
      // Bitmaps from Electron are BGRA.
      pixels[offset] = b
      pixels[offset + 1] = g
      pixels[offset + 2] = r
      pixels[offset + 3] = 255
    }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size })
  icons.set(status, image)
  return image
}

const LOGO = `<svg viewBox="0 0 64 64" width="28" height="28"><defs><radialGradient id="g" cx=".5" cy=".38" r=".65"><stop offset="0" stop-color="#22D3EE"/><stop offset="1" stop-color="#6366F1"/></radialGradient></defs><circle cx="32" cy="32" r="21" fill="url(#g)"/><path d="M22 24 L30 31 L22 38" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path class="u" d="M33 40 H43" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`

const BASE_STYLE = `
  html, body { margin: 0; height: 100%; background: transparent; color: #e6ebf7; font: 14px "Segoe UI", system-ui, sans-serif; overflow: hidden; }
  .card { box-sizing: border-box; height: calc(100% - 12px); margin: 6px; padding: 14px 16px; border-radius: 16px; background: rgba(15, 24, 51, 0.97);
    box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.45), 0 14px 34px rgba(0, 0, 0, 0.45); animation: in 220ms cubic-bezier(.34,1.32,.64,1) both; }
  @keyframes in { from { opacity: 0; transform: translateY(8px) scale(.96); } }
  .u { animation: blink 1.05s steps(1) infinite; } @keyframes blink { 50% { opacity: 0; } }
  input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; color: #fff; font: inherit; font-size: 16px; }
  input::placeholder { color: #8b97b8; }
  small, .mut { color: #8b97b8; font-size: 12px; }
  button { border: 0; border-radius: 9px; height: 30px; padding: 0 12px; font: inherit; font-size: 12.5px; cursor: pointer; background: rgba(148,163,255,.14); color: #e6ebf7; }
  button.go { background: linear-gradient(135deg, #22d3ee, #6366f1); color: #fff; font-weight: 600; }
  kbd { padding: 0 5px; border-radius: 4px; border: 1px solid rgba(148,163,255,.3); border-bottom-width: 2px; font: 11px Consolas, monospace; color: #c7d0ea; }
`

const QUICK_PAGE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Pergunta rápida</title>
<style>${BASE_STYLE}
  .card { display: flex; flex-direction: column; justify-content: center; gap: 8px; -webkit-app-region: drag; }
  .row { display: flex; align-items: center; gap: 12px; }
  input, button { -webkit-app-region: no-drag; }
  .mic { width: 34px; height: 34px; padding: 0; border-radius: 50%; display: grid; place-items: center; }
  .mic:hover { background: rgba(34,211,238,.2); }
  body.sent .card { animation: out 260ms cubic-bezier(.65,0,.35,1) forwards; }
  @keyframes out { to { opacity: 0; transform: translate(220px, 160px) scale(.1); } }
</style></head>
<body>
  <div class="card">
    <div class="row">${LOGO}<input id="q" autofocus placeholder="Peça algo para a Lynx..." />
      <button class="mic" id="mic" title="Ditar (Win+H)">🎙</button></div>
    <small><kbd>Enter</kbd> envia numa conversa nova · <kbd>Ctrl</kbd>+<kbd>Espaço</kbd> dita · <kbd>Esc</kbd> fecha</small>
  </div>
<script>
  const q = document.getElementById("q")
  const dictate = () => { q.focus(); window.api.lynxDictate() }
  q.focus()
  document.getElementById("mic").addEventListener("click", dictate)
  q.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.api.quickAskClose()
    if (event.key === " " && event.ctrlKey) { event.preventDefault(); dictate() }
    if (event.key === "Enter" && q.value.trim()) {
      document.body.classList.add("sent")
      const text = q.value
      setTimeout(() => window.api.quickAskSubmit(text), 240)
    }
  })
</script>
</body></html>`

function escape(text: string) {
  return text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char)
}

const STATUS_LABEL: Record<AgentTrayState["status"], string> = {
  idle: "esperando",
  working: "trabalhando",
  done: "terminou",
  attention: "precisa de você",
}

function bubblePage(state: AgentTrayState) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Lynx</title>
<style>${BASE_STYLE}
  .card { display: flex; flex-direction: column; gap: 10px; }
  .head { display: flex; align-items: center; gap: 10px; }
  .chip { margin-left: auto; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; background: rgba(34,211,238,.16); box-shadow: inset 0 0 0 1px rgba(34,211,238,.5); }
  .now { padding: 8px 10px; border-radius: 10px; background: rgba(148,163,255,.08); font-size: 12.5px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .ask { display: flex; padding: 6px 10px; border-radius: 10px; box-shadow: inset 0 0 0 1px rgba(148,163,255,.25); }
  .ask input { font-size: 13.5px; }
  .row { display: flex; gap: 6px; }
</style></head>
<body>
  <div class="card">
    <div class="head">${LOGO}<b>Lynx</b><span class="chip">${STATUS_LABEL[state.status]}</span></div>
    <div class="now">${escape(state.tooltip)}</div>
    <div class="ask"><input id="q" placeholder="Pedir algo…" /></div>
    <div class="row"><button class="go" id="open">Abrir o Lynx Code</button><button id="mic">🎙 Ditar</button></div>
  </div>
<script>
  const q = document.getElementById("q")
  document.getElementById("open").addEventListener("click", () => window.api.lynxOpenMain())
  document.getElementById("mic").addEventListener("click", () => { q.focus(); window.api.lynxDictate() })
  q.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.api.quickAskClose()
    if (event.key === "Enter" && q.value.trim()) window.api.quickAskSubmit(q.value)
  })
</script>
</body></html>`
}

function notePage(state: AgentTrayState) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Lynx precisa de você</title>
<style>${BASE_STYLE}
  .card { display: flex; flex-direction: column; gap: 8px; box-shadow: 0 0 0 1px rgba(245,158,11,.6), 0 14px 34px rgba(0,0,0,.45); }
  .head { display: flex; align-items: center; gap: 10px; }
  .head b { flex: 1; }
  .x { width: 26px; height: 26px; padding: 0; background: transparent; color: #8b97b8; }
  .now { font-size: 12.5px; color: #c7d0ea; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .ask { display: flex; gap: 6px; }
  .ask input { padding: 0 10px; border-radius: 9px; box-shadow: inset 0 0 0 1px rgba(148,163,255,.25); font-size: 13px; }
</style></head>
<body>
  <div class="card">
    <div class="head">${LOGO}<b>A Lynx precisa de você</b><button class="x" id="close">✕</button></div>
    <div class="now">${escape(state.tooltip)}</div>
    <div class="ask"><input id="q" placeholder="Responder aqui…" /><button class="go" id="open">Abrir</button></div>
  </div>
<script>
  const q = document.getElementById("q")
  document.getElementById("close").addEventListener("click", () => window.api.quickAskClose())
  document.getElementById("open").addEventListener("click", () => window.api.lynxOpenMain())
  q.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.api.quickAskClose()
    if (event.key === "Enter" && q.value.trim()) window.api.lynxReply(q.value)
  })
</script>
</body></html>`
}
