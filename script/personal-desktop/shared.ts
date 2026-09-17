import { $ } from "bun"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { appendFile, mkdir, open, rm, stat, truncate } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Repository root (this file lives in script/personal-desktop). */
export const ROOT = path.resolve(import.meta.dir, "../..")
export const DESKTOP = path.join(ROOT, "packages", "desktop")

/**
 * Build state, logs and the staged installer live outside the repo. The desktop
 * app reads the same files (packages/desktop/src/main/personal-updater.ts).
 */
const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
export const HOME = path.join(LOCAL, "OpenCodePersonal")
export const LOG = path.join(HOME, "update.log")
export const STATE = path.join(HOME, "state.json")
export const PENDING = path.join(HOME, "OpenCodePersonalSetup.exe")
export const BUILD_LOCK = path.join(HOME, "update.lock")
export const INSTALL_LOCK = path.join(HOME, "install.lock")

export const PRODUCT = "OpenCode Personal"
export const EXE = `${PRODUCT}.exe`
export const INSTALLED_EXE = path.join(LOCAL, "Programs", "opencode-personal", EXE)

/** Build output, dependencies, tests and files the build itself writes. */
export const IGNORED =
  /[\\/](node_modules|dist|out|\.turbo|\.git|test|tests|resources|coverage)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$|\.log$/

/**
 * Source folders that end up in the desktop app: the desktop package, the server
 * it embeds (built from packages/opencode, not a package dependency) and every
 * workspace package those depend on, directly or not (app, ui, sdk, llm...).
 */
export const WATCHED = workspaceDependencies([DESKTOP, path.join(ROOT, "packages", "opencode")])

function workspaceDependencies(roots: string[]) {
  const packages = workspacePackages()
  const found = new Set<string>()
  const queue: string[] = roots.map((dir) => JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name)
  for (const name of queue) {
    const item = packages.get(name)
    if (!item || found.has(name)) continue
    found.add(name)
    queue.push(
      ...Object.entries({ ...item.pkg.dependencies, ...item.pkg.devDependencies })
        .filter(([dep, version]) => version.startsWith("workspace:") && packages.has(dep))
        .map(([dep]) => dep),
    )
  }
  return [...found].flatMap((name) => packages.get(name)?.dir ?? [])
}

/** `packages/<name>` and one level below it (e.g. `packages/sdk/js`), keyed by package name. */
function workspacePackages() {
  const base = path.join(ROOT, "packages")
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = path.join(base, entry.name)
      const nested = readdirSync(dir, { withFileTypes: true })
        .filter((child) => child.isDirectory() && !IGNORED.test(path.join(dir, child.name)))
        .map((child) => path.join(dir, child.name))
      return [dir, ...nested]
    })
  return new Map(
    dirs.flatMap((dir) => {
      const file = path.join(dir, "package.json")
      if (!existsSync(file)) return []
      const pkg = JSON.parse(readFileSync(file, "utf8")) as {
        name?: string
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      if (!pkg.name) return []
      return [[pkg.name, { dir, pkg }] as const]
    }),
  )
}

export type State = { builtAt?: number; sourceTime?: number; lastError?: string }

const MAX_LOG_BYTES = 5 * 1024 * 1024
/** A lock file is created empty and gets its pid right after; treat that instant as held. */
const LOCK_GRACE_MS = 10 * 1000

export async function log(message: string) {
  await mkdir(HOME, { recursive: true })
  const size = await stat(LOG).then(
    (info) => info.size,
    () => 0,
  )
  if (size > MAX_LOG_BYTES) await truncate(LOG, 0)
  const line = `[${new Date().toLocaleString("pt-BR")}] ${message}\n`
  await appendFile(LOG, line)
  process.stdout.write(line)
}

export async function readState(): Promise<State> {
  return Bun.file(STATE)
    .json()
    .catch(() => ({}))
}

export async function writeState(next: State) {
  await mkdir(HOME, { recursive: true })
  await Bun.write(STATE, JSON.stringify(next, null, 2))
}

/** True while the process that took the lock is alive. */
export async function lockHeld(file: string) {
  const info = await stat(file).catch(() => undefined)
  if (!info) return false
  const pid = Number(
    await Bun.file(file)
      .text()
      .catch(() => ""),
  )
  if (!pid) return Date.now() - info.mtimeMs < LOCK_GRACE_MS
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Takes the lock unless a live process holds it; locks left by dead processes are replaced. */
export async function acquireLock(file: string) {
  await mkdir(HOME, { recursive: true })
  if (await lockHeld(file)) return false
  await rm(file, { force: true })
  const handle = await open(file, "wx").catch(() => undefined)
  if (!handle) return false
  await handle.writeFile(String(process.pid))
  await handle.close()
  return true
}

export async function releaseLock(file: string) {
  const pid = Number(
    await Bun.file(file)
      .text()
      .catch(() => ""),
  )
  if (pid === process.pid) await rm(file, { force: true })
}

export async function appRunning() {
  const output = await $`tasklist /FI ${`IMAGENAME eq ${EXE}`} /NH`.nothrow().quiet().text()
  return output.toLowerCase().includes(EXE.toLowerCase())
}

/** Windows balloon notification; failures are ignored (it's only a courtesy). */
export async function notify(message: string) {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = [System.Drawing.SystemIcons]::Information",
    "$n.Visible = $true",
    `$n.ShowBalloonTip(8000, '${PRODUCT}', '${message.replaceAll("'", "''")}', 'Info')`,
    "Start-Sleep -Seconds 9",
    "$n.Dispose()",
  ].join("; ")
  Bun.spawn(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script], {
    stdout: "ignore",
    stderr: "ignore",
  })
}

/** Newest modification time among the watched source files. */
export async function newestSourceTime() {
  let newest = 0
  for (const dir of WATCHED) {
    const glob = new Bun.Glob("**/*")
    for await (const file of glob.scan({ cwd: dir, onlyFiles: true, dot: false })) {
      const full = path.join(dir, file)
      if (IGNORED.test(full)) continue
      const info = await stat(full).catch(() => undefined)
      if (info && info.mtimeMs > newest) newest = info.mtimeMs
    }
  }
  return newest
}

/**
 * Installs the staged installer when the app is closed. Returns false while the
 * app is open, so an update never interrupts work in progress. `relaunch` opens
 * the new version when the installer finishes (used by the app's update button).
 */
export async function installPending(options: { relaunch?: boolean } = {}) {
  if (!(await Bun.file(PENDING).exists())) return false
  if (await appRunning()) return false
  // The installer is still being written while a build holds its lock.
  if (await lockHeld(BUILD_LOCK)) return false
  // The watcher and the update button can both get here; a second installer
  // running at the same time exits with code 2 ("already running").
  if (!(await acquireLock(INSTALL_LOCK))) return false
  try {
    await log("Instalando a nova versão...")
    const args = options.relaunch ? ["/S", "--force-run"] : ["/S"]
    const result = await $`${PENDING} ${args}`.nothrow().quiet()
    if (result.exitCode !== 0) {
      await log(`Falha ao instalar (código ${result.exitCode}); tento de novo depois.`)
      return false
    }
    await $`cmd /c del /f /q ${PENDING}`.nothrow().quiet()
    await log("OpenCode Personal atualizado.")
    if (!options.relaunch) await notify("Atualizado com as últimas mudanças. Abra o app para ver.")
    return true
  } finally {
    await releaseLock(INSTALL_LOCK)
  }
}
