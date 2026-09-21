#!/usr/bin/env bun
/**
 * Publishes this checkout to GitHub, where the other PCs (set up with
 * instalar.ps1) pick it up on their own.
 *
 *   bun script/personal-desktop/publish.ts "o que mudou"
 *
 * The personal repository gets a snapshot of the code, not the official
 * project's history (see the end of README.md): local changes are committed
 * to `dev`, the tree of `dev` becomes the next commit of the `pessoal` branch,
 * and that branch is pushed as `dev` of the `meu` remote. Every snapshot has
 * the previous one as parent, so the other PCs only ever move forward.
 *
 * The repository is public, so before anything leaves this PC every file
 * about to be published is searched for the keys and sign-ins this PC holds
 * (auth.json, the extension's token, key environment variables); a single hit
 * stops the publish.
 */
import { $ } from "bun"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { ENV, PLACES } from "./places"
import { ROOT } from "./shared"

const message = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
if (!message) {
  console.error('Uso: bun script/personal-desktop/publish.ts "o que mudou"')
  process.exit(2)
}

const git = (strings: TemplateStringsArray, ...values: unknown[]) => $(strings, ...values).cwd(ROOT).quiet()

/** Every key and sign-in this PC holds, which must never reach a public repository. */
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
    for (const match of readFileSync(file, "utf8").matchAll(/"(?:\w*token|\w*key|password|secret)"\s*:\s*"([^"]+)"/gi)) add(match[1])
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

/** Files of `tree` that contain any of `values`. */
async function leaks(tree: string, values: string[]) {
  if (!values.length) return []
  const files = (await git`git ls-tree -r --name-only ${tree}`.text()).split("\n").filter(Boolean)
  const hits: string[] = []
  for (const file of files) {
    const full = path.join(ROOT, file)
    const info = existsSync(full) ? statSync(full) : undefined
    if (!info?.isFile() || info.size > 20 * 1024 * 1024) continue
    const text = readFileSync(full, "latin1")
    if (values.some((value) => text.includes(value))) hits.push(file)
  }
  return hits
}

// 1. Local changes become a commit on dev.
if ((await git`git status --porcelain`.text()).trim()) {
  await git`git add -A`
  await git`git commit -m ${message}`
  console.log("Mudanças locais salvas num commit na dev.")
}

// 2. Nothing secret goes out.
const tree = (await git`git rev-parse dev^{tree}`.text()).trim()
const exposed = await leaks(tree, await secrets())
if (exposed.length) {
  console.error("\nPARADO: estes arquivos contêm uma chave ou login seu e o repositório é público:")
  for (const file of exposed) console.error(`  - ${file}`)
  console.error("Tire a chave desses arquivos (ou coloque-os no .gitignore) e publique de novo.")
  process.exit(1)
}

// 3. Only forward from what is already published.
await git`git fetch meu dev`
const published = (await git`git rev-parse meu/dev`.text()).trim()
const base = (await git`git rev-parse pessoal`.nothrow().text()).trim()
if (!base || (await git`git merge-base --is-ancestor ${published} ${base}`.nothrow()).exitCode !== 0) {
  console.error("A branch 'pessoal' não contém o que já está no GitHub; nada foi enviado. Veja o fim do README.md.")
  process.exit(1)
}
if ((await git`git rev-parse ${base}^{tree}`.text()).trim() === tree) {
  console.log("O GitHub já tem este código; nada para publicar.")
  process.exit(0)
}

// 4. The snapshot, and the push (the pre-push hook typechecks the whole repository).
const snapshot = (await git`git commit-tree ${tree} -p ${base} -m ${message}`.text()).trim()
await git`git branch -f pessoal ${snapshot}`
console.log("Enviando ao GitHub (o hook confere os tipos do projeto antes; leva uns minutos)...")
const pushed = await $`git push meu pessoal:dev`.cwd(ROOT).nothrow()
if (pushed.exitCode !== 0) {
  await git`git branch -f pessoal ${base}`
  console.error("O envio falhou; a branch 'pessoal' voltou ao que era.")
  process.exit(1)
}
console.log(`Publicado (${snapshot.slice(0, 7)}). Os outros PCs atualizam em até 20 minutos, ou pelo botão Atualizar.`)
