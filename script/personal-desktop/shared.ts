import { $ } from "bun"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { appendFile, lstat, mkdir, open, rm, stat, truncate } from "node:fs/promises"
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
/**
 * Present on a PC that follows the published code instead of being where it is
 * written (instalar.ps1 creates it): updates come from `git pull` there, not
 * from files changing on disk.
 */
export const FOLLOW = path.join(HOME, "follow.json")

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

export type Follow = { remote: string; branch: string }

/** How this PC gets its updates, when it follows the published code. */
export async function following(): Promise<Follow | undefined> {
  const saved = await Bun.file(FOLLOW)
    .json()
    .catch(() => undefined)
  if (!saved || typeof saved.remote !== "string" || typeof saved.branch !== "string") return
  return saved as Follow
}

/** The files the repository keeps as symbolic links. */
async function linkedFiles() {
  const listed = await $`git ls-files -s`.cwd(ROOT).quiet().text()
  return listed
    .split("\n")
    .filter((line) => line.startsWith("120000 "))
    .map((line) => line.slice(line.indexOf("\t") + 1).trim())
    .filter(Boolean)
}

/**
 * Turns the repository's symbolic links into copies of what they point at.
 *
 * Windows only lets Git create real links with Developer Mode on, and without
 * it each link is checked out as a small text file holding the target's path.
 * The app's icons are such links, so a build from that checkout ships broken
 * images. Copying the targets in makes the checkout build the same everywhere,
 * and marking them skip-worktree keeps Git from counting them as local edits.
 * Real links are left alone.
 */
export async function materializeLinks() {
  const files = await linkedFiles()
  const copied: string[] = []
  for (const file of files) {
    const full = path.join(ROOT, file)
    const info = await lstat(full).catch(() => undefined)
    // A real link is already right; a placeholder is a few bytes of path.
    if (!info || info.isSymbolicLink() || !info.isFile() || info.size > 1024) continue
    const target = path.resolve(path.dirname(full), (await Bun.file(full).text()).trim())
    const source = await stat(target).catch(() => undefined)
    // A link to a folder (only the console's email templates) is not part of the app.
    if (!source?.isFile()) continue
    await Bun.write(full, Bun.file(target))
    copied.push(file)
  }
  if (copied.length) await $`git update-index --skip-worktree ${copied}`.cwd(ROOT).quiet().nothrow()
  return copied.length
}

/** Puts the link placeholders back, so Git can update them like any file. */
async function restoreLinks() {
  const files = await linkedFiles()
  if (!files.length) return
  await $`git update-index --no-skip-worktree ${files}`.cwd(ROOT).quiet().nothrow()
  await $`git checkout -- ${files}`.cwd(ROOT).quiet().nothrow()
}

/**
 * Brings a following PC up to the published code. Returns whether anything
 * new came in. Only ever moves forward: if this checkout has commits of its
 * own, or local edits in the way, it stays as it is and says so, rather than
 * throwing work away.
 */
export async function pullPublished(follow: Follow) {
  const fetched = await $`git fetch ${follow.remote} ${follow.branch}`.cwd(ROOT).quiet().nothrow()
  if (fetched.exitCode !== 0) {
    await log(`Não consegui buscar atualizações no GitHub: ${fetched.stderr.toString().trim().split("\n").at(-1)}`)
    return false
  }
  const head = (await $`git rev-parse HEAD`.cwd(ROOT).quiet().text()).trim()
  const published = (await $`git rev-parse FETCH_HEAD`.cwd(ROOT).quiet().text()).trim()
  if (head === published) return false
  const behind = await $`git merge-base --is-ancestor ${head} ${published}`.cwd(ROOT).quiet().nothrow()
  if (behind.exitCode !== 0) {
    await log("Este PC tem mudanças próprias no código; não atualizo por cima delas.")
    return false
  }
  await restoreLinks()
  // The lockfile is rewritten by `bun install` itself; a local copy of it is
  // never work of anyone's, and left in place it would block the update.
  await $`git checkout -- bun.lock`.cwd(ROOT).quiet().nothrow()
  const merged = await $`git merge --ff-only ${published}`.cwd(ROOT).quiet().nothrow()
  if (merged.exitCode !== 0) {
    await materializeLinks()
    await log(`Não consegui aplicar a atualização: ${merged.stderr.toString().trim().split("\n").at(-1)}`)
    return false
  }
  const changed = await $`git diff --name-only ${head} ${published}`.cwd(ROOT).quiet().text()
  if (/(^|\/)(package\.json|bun\.lock)$/m.test(changed)) {
    await log("Dependências mudaram; instalando...")
    const installed = await $`${process.execPath} install`.cwd(ROOT).quiet().nothrow()
    if (installed.exitCode !== 0) throw new Error(`bun install falhou:\n${installed.stderr.toString().slice(-2000)}`)
  }
  await materializeLinks()
  await log(`Código atualizado do GitHub (${head.slice(0, 7)} → ${published.slice(0, 7)}).`)
  return true
}
