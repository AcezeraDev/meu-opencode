import { spawn } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { app } from "electron"
import { getLogger } from "./logging"
import type { BuildStep } from "@opencode-ai/app/updater"
import type { UpdaterController, UpdaterState } from "./updater-controller"
import { setAppQuitting } from "./windows"

/**
 * Updater for personal builds (script/personal-desktop): instead of downloading
 * a release it rebuilds the app from the local checkout, so "Update" picks up the
 * code as it is on disk. The build scripts and this module share the files below.
 */
const HOME = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "OpenCodePersonal")
const STATE = join(HOME, "state.json")
const PENDING = join(HOME, "OpenCodePersonalSetup.exe")
const BUILD_LOCK = join(HOME, "update.lock")
const LOG = join(HOME, "update.log")
/** The lines update.ts logs as a build moves on (see its `step` calls), and what the button calls them. */
const STEPS: ReadonlyArray<readonly [string, BuildStep]> = [
  ["Esperando a compilação em andamento terminar", "waiting"],
  ["Preparando ícones", "icons"],
  ["Preparando metadados", "metadata"],
  ["Compilando servidor", "server"],
  ["Compilando interface e processo principal", "interface"],
  ["Gerando instalador", "installer"],
]
/** Where a build begins and ends in the log. */
const BUILD_START = /Compilando o OpenCode Personal|Esperando a compilação em andamento/
const BUILD_END = /Compilado em|ERRO|Nenhuma mudança nova/
/** Printed by update.ts once it is really compiling (or waiting for a build in progress). */
const BUILDING_MARKER = "::opencode-personal-building::"
/** A lock file is created empty and gets its pid right after; treat that instant as held. */
const LOCK_GRACE_MS = 10 * 1000
/** How often the app looks for builds started by the watcher. */
const REFRESH_MS = 15 * 1000

// Baked in by script/personal-desktop/update.ts through electron.vite.config.ts.
const ROOT = import.meta.env.OPENCODE_PERSONAL_ROOT
const BUN = import.meta.env.OPENCODE_PERSONAL_BUN
const SOURCE_TIME = Number(import.meta.env.OPENCODE_PERSONAL_SOURCE_TIME) || 0

type BuildState = { builtAt?: number; sourceTime?: number; lastError?: string }

const SCRIPTS = ROOT ? join(ROOT, "script", "personal-desktop") : ""

/**
 * Whether this PC has the checkout the app was built from. Elsewhere (a PC set
 * up by instalar.ps1) there is nothing to compile, so the app updates from the
 * GitHub Release with electron-updater instead, like the official app.
 */
export function buildsFromSource() {
  return app.isPackaged && !!BUN && existsSync(BUN) && existsSync(join(SCRIPTS, "update.ts"))
}

/**
 * PCs installed before the app could update itself got a scheduled task that
 * downloaded the whole installer every few hours. The app does that now, so the
 * task only gets in the way; removing a task that is not there is a no-op.
 */
export function retireReleaseTask() {
  spawn("schtasks", ["/Delete", "/TN", "OpenCode Personal - Atualizar", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  }).once("error", () => {})
}

export function setupPersonalUpdater(stop: () => Promise<void>): UpdaterController {
  const logger = getLogger()
  const scripts = SCRIPTS
  const enabled = buildsFromSource()
  let state: UpdaterState = enabled ? { status: "idle" } : { status: "disabled" }
  let pending: Promise<UpdaterState> | undefined
  const listeners = new Set<(state: UpdaterState) => void>()

  const transition = (next: UpdaterState) => {
    if (JSON.stringify(next) === JSON.stringify(state)) return state
    logger.log("personal updater state changed", { from: state.status, to: next.status })
    state = next
    listeners.forEach((listener) => listener(state))
    return state
  }

  /** What the build scripts left on disk: a build in progress, or a staged build newer than this app. */
  const observed = (): UpdaterState | undefined => {
    if (lockHeld(BUILD_LOCK)) return { status: "downloading", version: "", ...progress() }
    const saved = readBuildState()
    if (existsSync(PENDING) && (saved.sourceTime ?? 0) > SOURCE_TIME)
      return { status: "ready", version: buildLabel(saved.builtAt) }
    return
  }

  // Builds started by the watcher show up here without a click.
  const refresh = () => {
    if (!enabled || state.status === "installing") return state
    // A build this app started is waited on elsewhere; only its progress is read here.
    if (pending) return state.status === "downloading" ? transition({ ...state, ...progress() }) : state
    const next = observed()
    if (next) return transition(next)
    if (state.status === "downloading" || state.status === "ready") return transition({ status: "idle" })
    return state
  }

  const check = () => {
    if (!enabled || state.status === "ready" || state.status === "installing") return Promise.resolve(state)
    if (pending) return pending

    pending = new Promise<UpdaterState>((resolve) => {
      transition({ status: "checking" })
      // Detached, like install.ts below: a build takes many minutes, and one
      // started here used to die with the app when it was closed or restarted
      // meanwhile, leaving half a build and a stale lock. Detached, it finishes
      // on its own; its output is only read while this app is still here.
      const child = spawn(BUN, [join(scripts, "update.ts"), "--from-app", `--installed=${SOURCE_TIME}`], {
        cwd: ROOT,
        env: scriptEnv(),
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      })
      const finish = (next: UpdaterState) => resolve(transition(next))
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        if (chunk.includes(BUILDING_MARKER)) transition({ status: "downloading", version: "", ...progress() })
      })
      child.once("error", (error) => finish({ status: "error", message: error.message }))
      child.once("exit", (code) => {
        if (code === 0) return finish(observed() ?? { status: "up-to-date" })
        const reason = readBuildState().lastError?.split("\n")[0]
        finish({
          status: "error",
          message: `${reason ?? `update.ts exited with code ${code}`} (${join(HOME, "update.log")})`,
        })
      })
    }).finally(() => {
      pending = undefined
    })
    return pending
  }

  return {
    getState: () => state,
    subscribe(listener: (state: UpdaterState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async start() {
      if (!enabled) return state
      const timer = setInterval(refresh, REFRESH_MS)
      timer.unref()
      app.once("will-quit", () => clearInterval(timer))
      return refresh()
    },
    check,
    async install() {
      if (state.status !== "ready") throw new Error("Update is not ready to install")
      const version = state.version
      transition({ status: "installing", version })
      await stop()
        .then(() => {
          // install.ts waits for this app to close, runs the installer and opens the new version.
          spawn(BUN, [join(scripts, "install.ts")], {
            cwd: ROOT,
            env: scriptEnv(),
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }).unref()
          setAppQuitting()
          app.quit()
        })
        .catch((error) => {
          transition({ status: "ready", version })
          throw error
        })
    },
  }
}

/**
 * The build in progress as update.ts logs it: the step it is on and when it
 * began, so the button can say more than "Building…" through a ten-minute build.
 */
function progress(): { step?: BuildStep; started?: number } {
  const lines = (() => {
    try {
      return readFileSync(LOG, "utf8").split("\n").slice(-60)
    } catch {
      return []
    }
  })()
  const start = lines.findLastIndex((line) => BUILD_START.test(line))
  if (start < 0 || lines.slice(start).some((line) => BUILD_END.test(line))) return {}
  const step = lines
    .slice(start)
    .flatMap((line) => STEPS.filter(([text]) => line.includes(text)).map(([, id]) => id))
    .at(-1)
  return { step, started: logTime(lines[start]!) }
}

/** The time update.ts stamps on a line, `[dd/mm/yyyy, hh:mm:ss]` in local time (pt-BR). */
function logTime(line: string) {
  const match = /^\[(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})\]/.exec(line)
  if (!match) return undefined
  const [, day, month, year, hour, minute, second] = match.map(Number)
  return new Date(year!, month! - 1, day!, hour!, minute!, second!).getTime()
}

function readBuildState(): BuildState {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"))
  } catch {
    return {}
  }
}

/** True while the process that took the lock is alive (same rule as script/personal-desktop/shared.ts). */
function lockHeld(file: string) {
  try {
    const pid = Number(readFileSync(file, "utf8"))
    if (!pid) return Date.now() - statSync(file).mtimeMs < LOCK_GRACE_MS
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function buildLabel(time: number | undefined) {
  if (!time) return ""
  return new Date(time).toLocaleString(app.getLocale(), {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** The app's environment without its own OpenCode/Electron settings, with Bun on the PATH. */
function scriptEnv() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_") && !key.startsWith("ELECTRON_")),
  )
  // Windows spells it "Path"; adding a second "PATH" key would make the child pick one arbitrarily.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
  return { ...env, [pathKey]: [dirname(BUN), env[pathKey]].filter(Boolean).join(delimiter) }
}
