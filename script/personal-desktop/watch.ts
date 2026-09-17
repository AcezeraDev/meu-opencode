#!/usr/bin/env bun
/**
 * Keeps OpenCode Personal up to date: when source files change it waits for a
 * quiet period, rebuilds and installs (after the app is closed, if it's open).
 * Started at logon by the launcher that startup.ts creates.
 *
 *   bun script/personal-desktop/watch.ts
 */
import { watch } from "node:fs"
import path from "node:path"
import { IGNORED, WATCHED, installPending, log, newestSourceTime, readState } from "./shared"

/** Edits usually come in bursts; build only after this long without changes. */
const QUIET_MS = 2 * 60 * 1000
const INSTALL_CHECK_MS = 30 * 1000

let timer: ReturnType<typeof setTimeout> | undefined
let building = false
let changedDuringBuild = false

function schedule(delay = QUIET_MS) {
  if (building) {
    changedDuringBuild = true
    return
  }
  if (timer) clearTimeout(timer)
  timer = setTimeout(build, delay)
}

async function build() {
  timer = undefined
  building = true
  changedDuringBuild = false
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "update.ts")], {
    stdout: "ignore",
    stderr: "ignore",
  })
  await child.exited
  building = false
  if (changedDuringBuild) schedule()
}

for (const dir of WATCHED) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (!file) return
    const full = path.join(dir, file.toString())
    if (IGNORED.test(full)) return
    schedule()
  })
}

// An install can outlast the check interval; overlapping runs make the second
// installer exit with code 2 ("already running").
let installing = false
setInterval(() => {
  if (building || installing) return
  installing = true
  void installPending().finally(() => {
    installing = false
  })
}, INSTALL_CHECK_MS)

await log("Vigia do OpenCode Personal iniciado.")
// Catch up on changes made while the watcher wasn't running.
const state = await readState()
if (!state.sourceTime || (await newestSourceTime()) > state.sourceTime) {
  await log("Há mudanças desde a última compilação; atualizando em breve.")
  schedule(10 * 1000)
}
