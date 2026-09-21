#!/usr/bin/env bun
/**
 * Restores a settings pack made by export.ts on another PC.
 *
 *   bun script/personal-desktop/import.ts C:\caminho\OpenCode-configuracoes.ocpack
 *   bun script/personal-desktop/import.ts <arquivo> --forcar   even with the app open
 *
 * The password comes in OPENCODE_PACK_SENHA or is asked for. The app has to be
 * closed, since it would write its own preferences back over these as it
 * quits. Anything that already existed here is copied aside first, to
 * `~/.local/share/opencode/importacao-<data>`, so nothing is lost. Paths that
 * named the other PC's user folder are rewritten to this one's.
 */
import { $ } from "bun"
import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { open, type Entry } from "./pack"
import { PLACES, TEXT, relocate, type Place } from "./places"
import { PRODUCT, appRunning } from "./shared"

const file = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
if (!file) {
  console.error("Uso: bun script/personal-desktop/import.ts <arquivo.ocpack>")
  process.exit(2)
}
if (!existsSync(file)) {
  console.error(`Arquivo não encontrado: ${file}`)
  process.exit(2)
}
if (!process.argv.includes("--forcar") && (await appRunning())) {
  console.error(`Feche o ${PRODUCT} antes de importar: ele gravaria as preferências dele por cima destas ao fechar.`)
  process.exit(1)
}

const secret = process.env.OPENCODE_PACK_SENHA ?? prompt("Senha do arquivo de configurações:") ?? ""
let entries: Entry[]
try {
  entries = open(await readFile(file), secret)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const meta = JSON.parse(entries.find((entry) => entry.name === "meta.json")?.data.toString("utf8") ?? "{}") as {
  home?: string
  createdAt?: number
  version?: string
}
const env = JSON.parse(entries.find((entry) => entry.name === "env.json")?.data.toString("utf8") ?? "{}") as Record<
  string,
  string
>

const moved = !!meta.home && path.resolve(meta.home).toLowerCase() !== path.resolve(os.homedir()).toLowerCase()

function rewrite(name: string, data: Buffer) {
  if (!moved || !TEXT.test(name)) return data
  return Buffer.from(relocate(data.toString("utf8"), meta.home!, os.homedir()), "utf8")
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
const backup = path.join(PLACES.data, `importacao-${stamp}`)
let backedUp = 0
const counts: Record<string, number> = {}

for (const entry of entries) {
  const slash = entry.name.indexOf("/")
  if (slash < 0) continue
  const place = entry.name.slice(0, slash) as Place
  const root = PLACES[place]
  if (!root) continue
  const relative = entry.name.slice(slash + 1)
  const target = path.resolve(root, ...relative.split("/"))
  // A name that climbs out of its folder would write somewhere it was never meant to.
  if (!target.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) continue

  if (existsSync(target)) {
    const saved = path.join(backup, place, ...relative.split("/"))
    await mkdir(path.dirname(saved), { recursive: true })
    await copyFile(target, saved)
    backedUp++
  }
  // A database arrives whole; a write-ahead log left from before would be replayed over it.
  if (/\.(db|sqlite)$/.test(target)) {
    for (const suffix of ["-wal", "-shm"]) await rm(target + suffix, { force: true })
  }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, rewrite(relative, entry.data))
  counts[place] = (counts[place] ?? 0) + 1
}

for (const [name, value] of Object.entries(env)) {
  await $`powershell -NoProfile -Command ${`[Environment]::SetEnvironmentVariable('${name.replaceAll("'", "''")}', $env:OC_VALOR, 'User')`}`
    .env({ ...process.env, OC_VALOR: value })
    .quiet()
}

const made = meta.createdAt ? new Date(meta.createdAt).toLocaleString("pt-BR") : "?"
console.log(`\nConfigurações importadas (pacote de ${made}):`)
console.log(`  - configuração, agentes e skills: ${counts.config ?? 0} arquivos`)
console.log(`  - chaves, logins e histórico: ${counts.data ?? 0} arquivos`)
console.log(`  - preferências do app: ${counts.app ?? 0} arquivos`)
console.log(`  - variáveis de ambiente: ${Object.keys(env).join(", ") || "nenhuma"}`)
if (moved) console.log(`  - caminhos de ${meta.home} trocados por ${os.homedir()}`)
if (backedUp) console.log(`\nO que já existia aqui foi guardado em ${backup}`)
