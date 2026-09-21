#!/usr/bin/env bun
/**
 * Packs OpenCode Personal's settings into one encrypted file, to set up another
 * PC with import.ts (which instalar.ps1 runs for you).
 *
 *   bun script/personal-desktop/export.ts                   asks for a password
 *   bun script/personal-desktop/export.ts --sem-historico   leaves conversations out
 *   bun script/personal-desktop/export.ts --saida=C:\x.ocpack
 *
 * The password can also come in OPENCODE_PACK_SENHA (exportar.ps1 asks for it
 * without echoing it). What goes in is listed in places.ts: config, agents and
 * skills, API keys and sign-ins, the key environment variables, the app's
 * preferences and, unless left out, the conversation history.
 */
import { Database } from "bun:sqlite"
import { $ } from "bun"
import { existsSync, readdirSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MIN_PASSWORD, seal, type Entry } from "./pack"
import {
  APP_DATABASES,
  APP_FILE,
  APP_FOLDERS,
  DATA_DATABASES,
  DATA_FILES,
  DATA_FOLDERS,
  ENV,
  HISTORY_DATABASES,
  PLACES,
  SKIP_IN_CONFIG,
} from "./places"
import { ROOT } from "./shared"

const args = process.argv.slice(2)
const withHistory = !args.includes("--sem-historico")
const output = args.find((arg) => arg.startsWith("--saida="))?.slice("--saida=".length)

const entries: Entry[] = []
const summary: string[] = []

function walk(dir: string, skip?: RegExp): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (skip?.test(full)) continue
    if (item.isDirectory()) found.push(...walk(full, skip))
    else if (item.isFile()) found.push(full)
  }
  return found
}

async function addFile(place: keyof typeof PLACES, full: string) {
  const relative = path.relative(PLACES[place], full).split(path.sep).join("/")
  entries.push({ name: `${place}/${relative}`, data: await readFile(full) })
}

/**
 * A database is copied through SQLite rather than as a file: the app may be
 * open and writing, and a file copied mid-write, or without its write-ahead
 * log, comes out missing the latest changes or broken.
 */
function addDatabase(place: keyof typeof PLACES, name: string) {
  const full = path.join(PLACES[place], name)
  if (!existsSync(full)) return false
  const db = new Database(full, { readonly: true })
  try {
    entries.push({ name: `${place}/${name}`, data: Buffer.from(db.serialize()) })
  } finally {
    db.close()
  }
  return true
}

async function userEnvironment() {
  const script = `[Environment]::GetEnvironmentVariables('User').GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value }`
  const text = await $`powershell -NoProfile -Command ${script}`.nothrow().quiet().text()
  const found: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=")
    if (at <= 0) continue
    const name = line.slice(0, at).trim()
    if (ENV.test(name)) found[name] = line.slice(at + 1)
  }
  return found
}

async function password() {
  const given = process.env.OPENCODE_PACK_SENHA
  if (given) return given
  const first = prompt(`Senha para proteger o arquivo (mínimo ${MIN_PASSWORD} caracteres):`) ?? ""
  const second = prompt("Digite a senha de novo:") ?? ""
  if (first !== second) throw new Error("As senhas não conferem.")
  return first
}

async function desktop() {
  const text = await $`powershell -NoProfile -Command ${"[Environment]::GetFolderPath('Desktop')"}`
    .nothrow()
    .quiet()
    .text()
  return text.trim() || path.join(os.homedir(), "Desktop")
}

// Config, agents, skills and scripts.
const config = walk(PLACES.config, SKIP_IN_CONFIG)
for (const file of config) await addFile("config", file)
summary.push(`configuração, agentes e skills: ${config.length} arquivos`)

// Keys, sign-ins and feature settings.
for (const name of DATA_FILES) {
  const full = path.join(PLACES.data, name)
  if (existsSync(full)) await addFile("data", full)
}
for (const folder of DATA_FOLDERS) for (const file of walk(path.join(PLACES.data, folder))) await addFile("data", file)
for (const name of DATA_DATABASES) addDatabase("data", name)
summary.push("chaves de API, logins e contas, e configurações de recursos")

if (withHistory) {
  const saved = HISTORY_DATABASES.filter((name) => addDatabase("data", name))
  summary.push(`histórico de conversas (${saved.join(", ") || "nenhum encontrado"})`)
} else summary.push("histórico de conversas: deixado de fora")

// The desktop app's preferences.
if (existsSync(PLACES.app)) {
  for (const item of readdirSync(PLACES.app)) {
    const full = path.join(PLACES.app, item)
    if (APP_FILE.test(item) && statSync(full).isFile()) await addFile("app", full)
  }
  for (const name of APP_DATABASES) addDatabase("app", name)
  for (const folder of APP_FOLDERS) {
    for (const file of walk(path.join(PLACES.app, folder))) {
      if (path.basename(file) !== "LOCK") await addFile("app", file)
    }
  }
  summary.push("preferências do app (modelo por projeto, atalhos, janelas)")
}

const env = await userEnvironment()
entries.push({ name: "env.json", data: Buffer.from(JSON.stringify(env, null, 2)) })
summary.push(`variáveis de ambiente: ${Object.keys(env).join(", ") || "nenhuma"}`)

const version = await Bun.file(path.join(ROOT, "packages", "opencode", "package.json"))
  .json()
  .then((pkg: { version: string }) => pkg.version)
entries.push({
  name: "meta.json",
  data: Buffer.from(
    JSON.stringify({ home: os.homedir(), user: os.userInfo().username, createdAt: Date.now(), version }, null, 2),
  ),
})

const secret = await password()
const sealed = seal(entries, secret)
const target =
  output ?? path.join(await desktop(), `OpenCode-configuracoes-${new Date().toISOString().slice(0, 10)}.ocpack`)
await writeFile(target, sealed)

console.log("\nPacote de configurações criado:")
console.log(`  ${target} (${(sealed.length / 1024 / 1024).toFixed(1)} MB)`)
console.log("\nLeva:")
for (const line of summary) console.log(`  - ${line}`)
console.log("\nGuarde a senha: sem ela o arquivo não abre. Não coloque o arquivo no GitHub.")
