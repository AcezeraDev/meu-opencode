#!/usr/bin/env bun
/**
 * Publishes the *already built* OpenCode Personal installer to a GitHub Release,
 * so another PC installs it by downloading and running it — no clone, no Bun, no
 * compiling. This is the counterpart of instalar.ps1's download step.
 *
 *   bun script/personal-desktop/release.ts            publish the current build
 *   bun script/personal-desktop/release.ts "texto"    with a release note
 *
 * It uploads three assets to a fixed tag (personal-latest), so the download URLs
 * never change:
 *   - OpenCodePersonalSetup.exe   the NSIS installer (built by update.ts/watch.ts)
 *   - opencode-import.exe         a standalone importer for the .ocpack settings
 *   - version.json                the version a following PC compares against
 *
 * The repository is public, so before uploading it scans both exes for any key
 * or sign-in this PC holds and refuses to publish if one is embedded. The
 * installer is built without secrets (keys live in auth.json / the .ocpack, not
 * in the app), so this only ever guards against a mistake.
 */
import { $ } from "bun"
import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ENV, PLACES } from "./places"
import { DESKTOP, PENDING, ROOT } from "./shared"

const TAG = "personal-latest"
const REPO = "AcezeraDev/meu-opencode"
const note = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "Atualização do OpenCode Personal"

const git = (strings: TemplateStringsArray, ...values: unknown[]) => $(strings, ...values).cwd(ROOT).quiet()

/** Every key and sign-in this PC holds, which must never reach a public release. */
async function secrets() {
  const found = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length >= 12) found.add(value)
  }
  const auth = path.join(PLACES.data, "auth.json")
  if (existsSync(auth)) {
    for (const entry of Object.values(JSON.parse(readFileSync(auth, "utf8")) as Record<string, Record<string, unknown>>)) {
      add(entry.key)
      add(entry.access)
      add(entry.refresh)
    }
  }
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const file = path.join(PLACES.config, name)
    if (!existsSync(file)) continue
    for (const match of readFileSync(file, "utf8").matchAll(/"(?:\w*token|\w*key|password|secret)"\s*:\s*"([^"]+)"/gi)) add(match[1]!)
  }
  const listed = await $`powershell -NoProfile -Command ${"[Environment]::GetEnvironmentVariables('User').GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value }"}`
    .nothrow()
    .quiet()
    .text()
  for (const line of listed.split(/\r?\n/)) {
    const at = line.indexOf("=")
    if (at > 0 && ENV.test(line.slice(0, at).trim())) add(line.slice(at + 1))
  }
  return [...found]
}

/** Whether a binary contains any of the secret strings (read as bytes, so any encoding shows). */
function contains(file: string, values: string[]) {
  if (!values.length) return false
  const text = readFileSync(file, "latin1")
  return values.some((value) => text.includes(value))
}

// 1. The installer the watcher/update.ts built. Prefer the staged copy, since it
//    is the one the app itself would install.
const installer = existsSync(PENDING) ? PENDING : path.join(DESKTOP, "dist", "opencode-personal-win-x64.exe")
if (!existsSync(installer)) {
  console.error(`Não achei o instalador. Rode o app com o botão Atualizar (ou o vigia) para gerar um build, depois publique.`)
  console.error(`Procurei em:\n  ${PENDING}\n  ${path.join(DESKTOP, "dist", "opencode-personal-win-x64.exe")}`)
  process.exit(1)
}

// 2. The standalone tools, compiled fresh so they match the current scripts: the
//    importer for the .ocpack, and the updater a following PC runs with no repo.
const dist = path.join(DESKTOP, "dist")
await mkdir(dist, { recursive: true })
const importer = path.join(dist, "opencode-import.exe")
const updater = path.join(dist, "opencode-atualizar.exe")
for (const [source, out, label] of [
  ["import.ts", importer, "importador"],
  ["update-release.ts", updater, "atualizador"],
] as const) {
  console.log(`Compilando o ${label} standalone...`)
  const compiled = await $`bun build --compile --target=bun-windows-x64 ${path.join(ROOT, "script/personal-desktop", source)} --outfile ${out}`
    .cwd(ROOT)
    .nothrow()
  if (compiled.exitCode !== 0) {
    console.error(`Falha ao compilar o ${label}:\n` + compiled.stderr.toString().slice(-2000))
    process.exit(1)
  }
}

// 3. Nothing secret goes out.
const keys = await secrets()
const leaky = [installer, importer, updater].filter((file) => contains(file, keys))
if (leaky.length) {
  console.error("\nPARADO: um destes tem uma chave ou login seu embutido, e a Release é pública:")
  for (const file of leaky) console.error(`  - ${file}`)
  process.exit(1)
}

// 4. The version a following PC compares against, from the checkout being shipped.
const version = (await Bun.file(path.join(ROOT, "packages/opencode/package.json")).json()).version as string
const commit = (await git`git rev-parse --short HEAD`.nothrow().text()).trim() || "sem-git"
const marker = path.join(dist, "version.json")
const built = statSync(installer).mtimeMs
await writeFile(marker, JSON.stringify({ version, commit, builtAt: built, note, at: Date.now() }, null, 2))

// 5. Create or refresh the fixed-tag release, replacing its assets.
if ((await $`gh --version`.nothrow().quiet()).exitCode !== 0) {
  console.error("Preciso do GitHub CLI (gh) autenticado. Instale com: winget install GitHub.cli")
  process.exit(1)
}
const exists = (await $`gh release view ${TAG} -R ${REPO}`.nothrow().quiet()).exitCode === 0
const title = `OpenCode Personal ${version} (${commit})`
if (exists) {
  console.log(`Atualizando a Release ${TAG}...`)
  await $`gh release edit ${TAG} -R ${REPO} --title ${title} --notes ${note}`.nothrow().quiet()
} else {
  console.log(`Criando a Release ${TAG}...`)
  const created = await $`gh release create ${TAG} -R ${REPO} --title ${title} --notes ${note}`.nothrow()
  if (created.exitCode !== 0) {
    console.error("Falha ao criar a Release:\n" + created.stderr.toString().slice(-1500))
    process.exit(1)
  }
}

console.log("Enviando os arquivos (o instalador tem ~130 MB, pode demorar)...")
const uploaded = await $`gh release upload ${TAG} -R ${REPO} --clobber ${installer}#OpenCodePersonalSetup.exe ${importer}#opencode-import.exe ${updater}#opencode-atualizar.exe ${marker}#version.json`.nothrow()
if (uploaded.exitCode !== 0) {
  console.error("Falha ao enviar os arquivos:\n" + uploaded.stderr.toString().slice(-1500))
  process.exit(1)
}

const base = `https://github.com/${REPO}/releases/download/${TAG}`
console.log(`\nPublicado (${version}, ${commit}).`)
console.log(`Instalador:  ${base}/OpenCodePersonalSetup.exe`)
console.log(`Para instalar noutro PC, rode lá:`)
console.log(`  irm https://raw.githubusercontent.com/${REPO}/dev/script/personal-desktop/instalar.ps1 | iex`)
