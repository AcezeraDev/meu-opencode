#!/usr/bin/env bun
/**
 * Publishes OpenCode Personal builds to a GitHub Release, where every other PC
 * gets them: instalar.ps1 downloads the installer from there, and the installed
 * app updates itself from there with electron-updater (the latest.yml feed and
 * the .blockmap let it download only what changed).
 *
 * update.ts runs this on its own after every build on this PC (`--auto`): the
 * build is copied into RELEASES and the newest one waiting there is uploaded.
 * Run by hand, it publishes the build in packages/desktop/dist.
 *
 *   bun script/personal-desktop/release.ts            publish the current build
 *   bun script/personal-desktop/release.ts "texto"    with a release note
 *
 * Assets on the fixed tag (personal-latest), so the URLs never change:
 *   - OpenCodePersonalSetup.exe (+ .blockmap)   the NSIS installer
 *   - latest.yml                                what the installed app checks
 *   - opencode-import.exe                       restores a .ocpack (instalar.ps1)
 *   - version.json                              for PCs set up before the app updated itself
 *
 * The repository is public, so before uploading it scans the binaries for any
 * key or sign-in this PC holds and refuses to publish if one is embedded.
 */
import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { ENV, PLACES } from "./places"
import {
  DESKTOP,
  HOME,
  RELEASES,
  RELEASE_FILES,
  RELEASE_LOCK,
  ROOT,
  acquireLock,
  log,
  newestSourceTime,
  readState,
  releaseLock,
} from "./shared"

const TAG = "personal-latest"
const REPO = "AcezeraDev/meu-opencode"
const IMPORTER_STATE = path.join(HOME, "release-importer.json")
const IMPORTER_SOURCES = ["import.ts", "pack.ts", "places.ts"]
const auto = process.argv.includes("--auto")
const note = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "Atualização do OpenCode Personal"

if ((await $`gh auth status`.nothrow().quiet()).exitCode !== 0) {
  await log("Release: o GitHub CLI (gh) não está instalado ou logado; o build não foi publicado.")
  process.exit(1)
}

if (!auto) await stageDist()
// Another upload is running; it picks up the newest build when it finishes.
if (!(await acquireLock(RELEASE_LOCK))) process.exit(0)
try {
  await ensureRelease()
  for (let build = newestStaged(); build; build = newestStaged()) await publish(build)
} finally {
  await releaseLock(RELEASE_LOCK)
}

/** Uploads one staged build, then removes it (and any older one) from RELEASES. */
async function publish(build: string) {
  const dir = path.join(RELEASES, build)
  // Only the newest build matters; older ones waiting behind it are dropped.
  for (const old of staged().filter((name) => name !== build)) await rm(path.join(RELEASES, old), { recursive: true, force: true })

  const installer = path.join(dir, RELEASE_FILES[0]!)
  const keys = await secrets()
  if (contains(installer, keys)) {
    await log(`Release PARADA: o instalador ${build} tem uma chave ou login seu embutido, e a Release é pública.`)
    await rm(dir, { recursive: true, force: true })
    return
  }

  const importer = await freshImporter(keys)
  const version = path.join(dir, "version.json")
  await writeFile(
    version,
    JSON.stringify({ version: build, commit: build, builtAt: statSync(installer).mtimeMs, note, at: Date.now() }, null, 2),
  )

  await log(`Release: enviando ${build} para o GitHub...`)
  // latest.yml goes last: until it is replaced, apps keep being pointed at the
  // previous installer instead of one that is still uploading.
  const first = [installer, path.join(dir, RELEASE_FILES[1]!), version, ...(importer ? [importer] : [])]
  for (const files of [first, [path.join(dir, RELEASE_FILES[2]!)]]) {
    const uploaded = await $`gh release upload ${TAG} -R ${REPO} --clobber ${files}`.nothrow().quiet()
    if (uploaded.exitCode !== 0) {
      await log(`Release: falha ao enviar (${uploaded.stderr.toString().trim().split("\n").at(-1)}); tento no próximo build.`)
      return await rm(dir, { recursive: true, force: true })
    }
  }
  if (importer) await writeFile(IMPORTER_STATE, JSON.stringify({ hash: importerHash() }))
  await $`gh release edit ${TAG} -R ${REPO} --title ${`OpenCode Personal ${build}`} --notes ${note}`.nothrow().quiet()
  await rm(dir, { recursive: true, force: true })
  await log(`Release: ${build} publicado; os outros PCs já podem atualizar.`)
}

/** Copies the build in packages/desktop/dist into RELEASES, refusing one older than the code. */
async function stageDist() {
  const dist = path.join(DESKTOP, "dist")
  const missing = RELEASE_FILES.filter((name) => !existsSync(path.join(dist, name)))
  if (missing.length) {
    console.error(`Não achei ${missing.join(", ")} em ${dist}.`)
    console.error("Deixe o vigia (ou o botão Atualizar do app) compilar uma versão e rode de novo.")
    process.exit(1)
  }
  // That is how a Release once went out without the bundled browser extension.
  if (((await readState()).sourceTime ?? 0) < (await newestSourceTime())) {
    console.error("O app ainda não recompilou com as últimas mudanças, então o instalador está velho.")
    console.error("Clique em Atualizar na barra de título, ou espere o vigia; o build novo sobe sozinho.")
    process.exit(1)
  }
  const version = /^version:\s*(\S+)/m.exec(readFileSync(path.join(dist, "latest.yml"), "utf8"))?.[1]
  if (!version) {
    console.error("O latest.yml do build não tem versão.")
    process.exit(1)
  }
  const dir = path.join(RELEASES, version)
  await mkdir(dir, { recursive: true })
  for (const name of RELEASE_FILES) await copyFile(path.join(dist, name), path.join(dir, name))
}

/** Build versions waiting in RELEASES, oldest first (versions sort by their time stamp). */
function staged() {
  if (!existsSync(RELEASES)) return []
  return readdirSync(RELEASES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RELEASE_FILES.every((name) => existsSync(path.join(RELEASES, entry.name, name))))
    .map((entry) => entry.name)
    .sort((a, b) => statSync(path.join(RELEASES, a)).mtimeMs - statSync(path.join(RELEASES, b)).mtimeMs)
}

function newestStaged() {
  return staged().at(-1)
}

async function ensureRelease() {
  if ((await $`gh release view ${TAG} -R ${REPO}`.nothrow().quiet()).exitCode === 0) return
  const created = await $`gh release create ${TAG} -R ${REPO} --title ${"OpenCode Personal"} --notes ${note}`.nothrow().quiet()
  if (created.exitCode === 0) return
  await log(`Release: falha ao criar (${created.stderr.toString().trim().split("\n").at(-1)}).`)
  process.exit(1)
}

/**
 * The importer only changes when its scripts do, and it is ~100 MB, so it is
 * rebuilt and uploaded only then. Returns its path when it must go up.
 */
async function freshImporter(keys: string[]) {
  const hash = importerHash()
  const saved = await Bun.file(IMPORTER_STATE)
    .json()
    .catch(() => ({}))
  if (saved.hash === hash) return
  const out = path.join(RELEASES, "opencode-import.exe")
  const compiled = await $`bun build --compile --target=bun-windows-x64 ${path.join(import.meta.dir, "import.ts")} --outfile ${out}`
    .cwd(ROOT)
    .nothrow()
    .quiet()
  if (compiled.exitCode !== 0 || contains(out, keys)) {
    await log("Release: não consegui preparar o importador; sobe o anterior.")
    return
  }
  return out
}

function importerHash() {
  const hash = createHash("sha256")
  for (const name of IMPORTER_SOURCES) hash.update(readFileSync(path.join(import.meta.dir, name)))
  return hash.digest("hex")
}

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
