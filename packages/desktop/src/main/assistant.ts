import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentTrayState } from "../preload/types"
import { write as writeLog } from "./logging"
import { appIconPath, getMainWindow } from "./windows"

/**
 * Two ways to reach the agent without bringing the app forward first: a global
 * shortcut that opens a small box to ask something from anywhere in Windows,
 * and an icon next to the clock that shows whether the agent is working, done,
 * or waiting for the person, with the step it is on as its tooltip.
 */

const SHORTCUT = "CommandOrControl+Shift+Space"
const SHORTCUT_LABEL = "Ctrl+Shift+Espaço"
const root = dirname(fileURLToPath(import.meta.url))

const DOT: Record<AgentTrayState["status"], [number, number, number] | undefined> = {
  idle: undefined,
  working: [56, 189, 248],
  done: [34, 197, 94],
  attention: [245, 158, 11],
}

let tray: Tray | undefined
let quick: BrowserWindow | undefined
let current: AgentTrayState = { status: "idle", tooltip: "OpenCode" }
const icons = new Map<AgentTrayState["status"], Electron.NativeImage>()

export function setupAssistant() {
  ipcMain.handle("quick-ask-submit", (_event, text: unknown) => {
    if (typeof text !== "string" || !text.trim()) return
    closeQuick()
    const win = showMain()
    win?.webContents.send("quick-ask", text.trim())
  })
  ipcMain.handle("quick-ask-close", () => closeQuick())
  ipcMain.handle("set-agent-tray", (_event, state: AgentTrayState) => updateTray(state))

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

function toggleQuick() {
  if (quick && !quick.isDestroyed()) {
    closeQuick()
    return
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = 640
  const height = 76
  quick = new BrowserWindow({
    width,
    height,
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + display.workArea.height * 0.22),
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#161616",
    title: "Pergunta rápida",
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
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

function createTray() {
  tray = new Tray(iconFor("idle"))
  tray.setToolTip(current.tooltip)
  tray.on("click", () => showMain())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir o OpenCode", click: () => showMain() },
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
      const [r, g, b] = distance > radius - 0.5 ? [20, 20, 20] : color
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

const QUICK_PAGE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Pergunta rápida</title>
<style>
  html, body { margin: 0; height: 100%; background: #161616; color: #ededed; font: 15px system-ui, "Segoe UI", sans-serif; overflow: hidden; }
  body { display: flex; flex-direction: column; justify-content: center; gap: 6px; padding: 0 16px; box-sizing: border-box; border: 1px solid #3a3a3a; border-radius: 10px; -webkit-app-region: drag; }
  input { -webkit-app-region: no-drag; width: 100%; box-sizing: border-box; background: transparent; border: 0; outline: 0; color: inherit; font: inherit; font-size: 17px; }
  input::placeholder { color: #8a8a8a; }
  small { color: #8a8a8a; font-size: 12px; }
</style></head>
<body>
  <input id="q" autofocus placeholder="Pergunte qualquer coisa à IA..." />
  <small>Enter envia numa conversa nova · Esc fecha</small>
<script>
  const q = document.getElementById("q")
  q.focus()
  q.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.api.quickAskClose()
    if (event.key === "Enter" && q.value.trim()) window.api.quickAskSubmit(q.value)
  })
</script>
</body></html>`
