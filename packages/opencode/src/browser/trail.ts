import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { Tab } from "./tab"

/**
 * A small picture of the page after each step the agent took, so the person
 * can look back over what it did in a lesson, step by step.
 *
 * Taken after the tool has answered, while the model is thinking about the
 * next step, and in the tab's own queue, so it neither delays the agent nor
 * lands in the middle of its next action. Kept on disk per session, by the
 * tool call it follows; a picture is small (a few tens of KB) and trails older
 * than `KEEP_DAYS` are removed.
 */

const KEEP_DAYS = 30
const SETTLE_QUIET = 400
const SETTLE_MAX = 2500
let pruned = false

/** Where a step's picture goes, or undefined for ids that are not plain. */
function fileOf(sessionID: string, callID: string) {
  if (!/^[\w-]+$/.test(sessionID) || !/^[\w.:-]+$/.test(callID)) return undefined
  return path.join(Global.Path.data, "browser-trail", sessionID, `${callID.replace(/[.:]/g, "_")}.jpg`)
}

/** Takes the picture for the step `callID` of `sessionID`, without holding anything up. */
export function capture(tab: Tab, sessionID: string, callID: string | undefined) {
  const file = callID ? fileOf(sessionID, callID) : undefined
  if (!file || !tab.connected) return
  void tab
    .serialize(async () => {
      // A click that loads content (a lesson's menu, an answer's feedback) is
      // still filling in when the tool answers; the picture waits for the page
      // to be still, so it shows what the step led to rather than a skeleton.
      await tab.quiet(SETTLE_QUIET, SETTLE_MAX)
      return tab.thumbnail()
    })
    .then(async (image) => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, image)
      if (!pruned) {
        pruned = true
        await prune()
      }
    })
    .catch(() => {})
}

/** The picture of a step, if one was taken. */
export async function read(sessionID: string, callID: string) {
  const file = fileOf(sessionID, callID)
  return file ? fs.readFile(file).catch(() => undefined) : undefined
}

async function prune() {
  const root = path.join(Global.Path.data, "browser-trail")
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = path.join(root, entry.name)
        const stat = await fs.stat(dir).catch(() => undefined)
        if (stat && stat.mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      }),
  )
}

export * as BrowserTrail from "./trail"
