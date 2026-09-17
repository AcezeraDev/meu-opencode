#!/usr/bin/env bun
/**
 * Started by the app's update button right before the app quits: waits for
 * OpenCode Personal to close, installs the staged build and opens the new version.
 *
 *   bun script/personal-desktop/install.ts
 */
import { spawn } from "node:child_process"
import { INSTALLED_EXE, INSTALL_LOCK, PENDING, appRunning, installPending, lockHeld, log, notify } from "./shared"

const CLOSE_TIMEOUT_MS = 2 * 60 * 1000

const deadline = Date.now() + CLOSE_TIMEOUT_MS
while (await appRunning()) {
  if (Date.now() > deadline) {
    await log("O app não fechou a tempo; a atualização fica para quando ele fechar.")
    await notify("Não deu para atualizar agora: o app não fechou. Tente de novo pelo botão Atualizar.")
    process.exit(1)
  }
  await Bun.sleep(1000)
}

await log("App fechado pelo botão de atualizar.")
// The installer opens the new version itself (--force-run).
if (await installPending({ relaunch: true })) process.exit(0)

// The watcher may have started the same install a moment earlier: wait for it.
while (await lockHeld(INSTALL_LOCK)) await Bun.sleep(1000)
if (await installPending({ relaunch: true })) process.exit(0)

// Nothing left to install (the watcher got there first) or the install failed:
// either way, don't leave the user without the app.
if (await Bun.file(PENDING).exists())
  await notify("Não deu para instalar a nova versão; abrindo a versão atual. Veja o update.log.")
spawn(INSTALLED_EXE, [], { detached: true, stdio: "ignore" }).unref()
