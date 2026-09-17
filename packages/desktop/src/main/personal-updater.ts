import { spawn } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { app } from "electron"
import { getLogger } from "./logging"
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

export function setupPersonalUpdater(stop: () => Promise<void>): UpdaterController {
  const logger = getLogger()
  const scripts = ROOT ? join(ROOT, "script", "personal-desktop") : ""
  const enabled = app.isPackaged && !!BUN && existsSync(BUN) && existsSync(join(scripts, "update.ts"))
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
    if (lockHeld(BUILD_LOCK)) return { status: "downloading", version: "" }
    const saved = readBuildState()
    if (existsSync(PENDING) && (saved.sourceTime ?? 0) > SOURCE_TIME)
      return { status: "ready", version: buildLabel(saved.builtAt) }
    return
  }

  // Builds started by the watcher show up here without a click.
  const refresh = () => {
    if (!enabled || pending || state.status === "installing") return state
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
      const child = spawn(BUN, [join(scripts, "update.ts"), "--from-app", `--installed=${SOURCE_TIME}`], {
        cwd: ROOT,
        env: scriptEnv(),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      })
      const finish = (next: UpdaterState) => resolve(transition(next))
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        if (chunk.includes(BUILDING_MARKER)) transition({ status: "downloading", version: "" })
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
