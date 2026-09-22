#!/usr/bin/env bun
/**
 * Keeps a "following" PC up to date from the GitHub Release, with no repository
 * and no Bun installed there: it is compiled to a standalone exe (see release.ts)
 * and run by a scheduled task that instalar.ps1 registers (at logon and every few
 * hours). The main PC does not use this — it builds from source (update.ts).
 *
 * It never disturbs the person: a newer build is downloaded whenever it appears,
 * but installed only while the app is closed, and the app is never force-opened.
 *
 *   opencode-atualizar.exe            check, download if newer, install if closed
 *   opencode-atualizar.exe --now      also install even while checking
 */
import { $ } from "bun"
import { existsSync, readFileSync } from "node:fs"
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const REPO = "AcezeraDev/meu-opencode"
const TAG = "personal-latest"
const BASE = `https://github.com/${REPO}/releases/download/${TAG}`

const LOCAL = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
const HOME = join(LOCAL, "OpenCodePersonal")
const PENDING = join(HOME, "OpenCodePersonalSetup.exe")
const PART = PENDING + ".part"
const MARKER = join(HOME, "release.json")
const LOG = join(HOME, "update.log")
const LOCK = join(HOME, "update.lock")
const PRODUCT = "OpenCode Personal"
const EXE = `${PRODUCT}.exe`

type Marker = { commit?: string; version?: string; installedAt?: number; staged?: string }

async function log(message: string) {
  await mkdir(HOME, { recursive: true }).catch(() => {})
  await appendFile(LOG, `[${new Date().toISOString()}] ${message}\n`).catch(() => {})
}

async function appRunning() {
  const output = await $`tasklist /FI ${`IMAGENAME eq ${EXE}`} /NH`.nothrow().quiet().text()
  return output.toLowerCase().includes(EXE.toLowerCase())
}

function readMarker(): Marker {
  try {
    return JSON.parse(readFileSync(MARKER, "utf8"))
  } catch {
    return {}
  }
}

/** A crude lock so two scheduled runs do not download or install at once. */
function locked() {
  if (!existsSync(LOCK)) return false
  try {
    const pid = Number(readFileSync(LOCK, "utf8"))
    if (pid) process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function install() {
  // Never yank the app out from under the person; catch it on a later run.
  if (await appRunning()) {
    await log("Nova versão baixada; instalo assim que o app estiver fechado.")
    return
  }
  await log("Instalando a nova versão...")
  const result = await $`${PENDING} /S`.nothrow().quiet()
  if (result.exitCode !== 0) {
    await log(`Falha ao instalar (código ${result.exitCode}); tento na próxima checagem.`)
    return
  }
  await $`cmd /c del /f /q ${PENDING}`.nothrow().quiet()
  const staged = readMarker().staged
  await writeFile(MARKER, JSON.stringify({ ...readMarker(), commit: staged, installedAt: Date.now(), staged: undefined }, null, 2))
  await log("OpenCode Personal atualizado.")
}

async function main() {
  if (locked()) return
  await mkdir(HOME, { recursive: true }).catch(() => {})
  await writeFile(LOCK, String(process.pid)).catch(() => {})
  try {
    // A build this updater staged on an earlier run installs as soon as the app
    // is closed. Only one it staged itself: a PENDING left by something else
    // (the source watcher on the main PC) is not ours to install.
    if (existsSync(PENDING) && readMarker().staged) return await install()

    const remote = (await fetch(`${BASE}/version.json`, { redirect: "follow" })
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined)) as Marker | undefined
    if (!remote?.commit) {
      await log("Não consegui checar a Release do GitHub agora.")
      return
    }
    if (readMarker().commit === remote.commit) return // already current

    await log(`Baixando ${remote.version ?? ""} (${remote.commit})...`)
    const response = await fetch(`${BASE}/OpenCodePersonalSetup.exe`, { redirect: "follow" }).catch(() => undefined)
    if (!response?.ok) {
      await log("Falha ao baixar o instalador.")
      return
    }
    await writeFile(PART, Buffer.from(await response.arrayBuffer()))
    await rm(PENDING, { force: true }).catch(() => {})
    await rename(PART, PENDING)
    await writeFile(MARKER, JSON.stringify({ ...readMarker(), staged: remote.commit, version: remote.version }, null, 2))
    await install()
  } finally {
    await rm(LOCK, { force: true }).catch(() => {})
  }
}

await main()
