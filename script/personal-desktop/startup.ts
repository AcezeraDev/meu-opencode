#!/usr/bin/env bun
/**
 * Starts the OpenCode Personal watcher now and at every Windows logon (a hidden
 * launcher in the user's Startup folder; no admin rights needed).
 *
 *   bun script/personal-desktop/startup.ts            install and start
 *   bun script/personal-desktop/startup.ts --remove   stop starting at logon
 */
import { rm } from "node:fs/promises"
import path from "node:path"
import { ROOT, log } from "./shared"

const startupDir = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
const launcher = path.join(startupDir, "OpenCode Personal Updater.vbs")

if (process.argv.includes("--remove")) {
  await rm(launcher, { force: true })
  await log("Vigia removido da inicialização do Windows.")
  process.exit(0)
}

const quote = (value: string) => `""${value}""`
const vbs = [
  'Set shell = CreateObject("WScript.Shell")',
  `shell.CurrentDirectory = "${ROOT}"`,
  `shell.Run "${quote(process.execPath)} ${quote(path.join(import.meta.dir, "watch.ts"))}", 0, False`,
  "",
].join("\r\n")
await Bun.write(launcher, vbs)
await log(`Vigia configurado para iniciar com o Windows (${launcher}).`)

// wscript returns right after starting the hidden watcher; waiting keeps this
// process alive long enough for the launch to happen.
await Bun.spawn(["wscript", launcher], { stdout: "ignore", stderr: "ignore" }).exited
await log("Vigia iniciado.")
