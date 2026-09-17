#!/usr/bin/env bun
/**
 * Builds "OpenCode Personal" (the desktop app with this checkout's changes) and
 * installs it next to the official OpenCode. When the app is open the new
 * version is staged and installed as soon as it's closed (see watch.ts), or
 * right away from the app's update button (see install.ts).
 *
 *   bun script/personal-desktop/update.ts            build when the source changed since the last build
 *   bun script/personal-desktop/update.ts --force    build even without changes
 *
 * The app's update button runs it with `--from-app --installed=<source time>`:
 * then the build is skipped when the staged installer, or the running app when
 * nothing is staged, already has the latest changes.
 */
import { $ } from "bun"
import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import {
  BUILD_LOCK,
  DESKTOP,
  HOME,
  PENDING,
  ROOT,
  acquireLock,
  appRunning,
  installPending,
  log,
  newestSourceTime,
  notify,
  readState,
  releaseLock,
  writeState,
} from "./shared"

/** Tells the app (which reads stdout) that a build is running, not just the change check. */
const BUILDING_MARKER = "::opencode-personal-building::"

const args = process.argv.slice(2)
const fromApp = args.includes("--from-app")
const force = args.includes("--force")
const installed = Number(args.find((arg) => arg.startsWith("--installed="))?.slice("--installed=".length)) || 0

async function step(name: string, command: $.ShellPromise) {
  await log(`${name}...`)
  const result = await command.nothrow().quiet()
  if (result.exitCode === 0) return
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`.trim().split("\n").slice(-25).join("\n")
  throw new Error(`${name} falhou (código ${result.exitCode}):\n${output}`)
}

/** Whether the last build (or, for the app, the version it will run next) already has these changes. */
async function upToDate(sourceTime: number) {
  const state = await readState()
  if (!fromApp) return (state.sourceTime ?? 0) >= sourceTime
  const staged = await Bun.file(PENDING).exists()
  return (staged ? (state.sourceTime ?? 0) : installed) >= sourceTime
}

async function build() {
  const started = Date.now()
  const sourceTime = await newestSourceTime()
  if (!force && (await upToDate(sourceTime))) {
    await log("Nenhuma mudança nova para compilar.")
    return "skipped" as const
  }

  process.stdout.write(`${BUILDING_MARKER}\n`)
  const env = {
    ...process.env,
    OPENCODE_CHANNEL: "dev",
    OPENCODE_PERSONAL: "1",
    // Baked into the app so its update button can rebuild from this checkout.
    OPENCODE_PERSONAL_ROOT: ROOT,
    OPENCODE_PERSONAL_BUN: process.execPath,
    OPENCODE_PERSONAL_SOURCE_TIME: String(sourceTime),
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  }

  try {
    await log("Compilando o OpenCode Personal com as mudanças atuais")
    // Same as scripts/prebuild.ts minus the v2 CLI download: personal builds run the
    // embedded server (with this checkout's changes), which doesn't need that binary.
    await step("Preparando ícones", $`bun ./scripts/copy-icons.ts dev`.cwd(DESKTOP).env(env))
    await step("Preparando metadados", $`bun ./scripts/copy-metainfo.ts dev`.cwd(DESKTOP).env(env))
    await step("Compilando servidor", $`bun script/build-node.ts`.cwd(path.join(DESKTOP, "..", "opencode")).env(env))
    await step("Compilando interface e processo principal", $`bun x electron-vite build`.cwd(DESKTOP).env(env))
    await step(
      "Gerando instalador",
      $`bun x electron-builder --win nsis --x64 --publish never --config electron-builder.config.ts`
        .cwd(DESKTOP)
        .env(env),
    )

    const built = path.join(DESKTOP, "dist", "opencode-personal-win-x64.exe")
    if (!(await Bun.file(built).exists())) throw new Error(`Instalador não encontrado em ${built}`)
    await copyFile(built, PENDING)
    await writeState({ ...(await readState()), builtAt: Date.now(), sourceTime, lastError: undefined })
    await log(`Compilado em ${Math.round((Date.now() - started) / 60000)} min.`)
    return "built" as const
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeState({ ...(await readState()), lastError: message })
    await log(`ERRO: ${message}`)
    await log("A versão instalada continua a mesma.")
    return "failed" as const
  }
}

await mkdir(HOME, { recursive: true })
if (!(await acquireLock(BUILD_LOCK))) {
  // Wait instead of giving up: changes made after that build started still need a build.
  await log("Esperando a compilação em andamento terminar...")
  if (fromApp) process.stdout.write(`${BUILDING_MARKER}\n`)
  while (!(await acquireLock(BUILD_LOCK))) await Bun.sleep(2000)
}

const result = await build().finally(() => releaseLock(BUILD_LOCK))
if (result === "failed") process.exitCode = 1
if (result === "built" && fromApp) await log("Nova versão pronta: reinicie pelo botão de atualizar do app.")
if (result === "built" && !fromApp && !(await installPending()) && (await appRunning())) {
  await log("App aberto: a nova versão será instalada assim que você fechar o OpenCode Personal.")
  await notify("Nova versão pronta. Use o botão Atualizar do app ou feche-o para instalar.")
}
