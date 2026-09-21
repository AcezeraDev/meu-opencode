/**
 * Where OpenCode Personal keeps what makes it yours, on any PC, and which of it
 * travels in a settings pack (export.ts / import.ts).
 *
 * Paths are named logically in the pack (`config/opencode.jsonc`), so a pack
 * made on one PC restores into the right folders on another, whatever the
 * Windows user is called there.
 */
import os from "node:os"
import path from "node:path"

const home = os.homedir()
const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")

export const PLACES = {
  /** Global config: opencode.jsonc (browser, providers), agents, skills, scripts. */
  config: path.join(home, ".config", "opencode"),
  /** API keys and sign-ins (auth.json), feature settings and, optionally, conversations. */
  data: path.join(home, ".local", "share", "opencode"),
  /** The desktop app's own preferences: models per project, shortcuts, window layout. */
  app: path.join(roaming, "ai.opencode.desktop.personal"),
} as const

export type Place = keyof typeof PLACES

/** Rebuilt on the other PC, or only meaningful on this one. */
export const SKIP_IN_CONFIG = /(^|[\\/])(node_modules|\.git)([\\/]|$)|\.log$/

/** The data files that are settings, not caches. Everything else there is rebuilt by use. */
export const DATA_FILES = ["auth.json", "web-video.json"]
export const DATA_FOLDERS = ["storage"]
/** Accounts and credentials of the local server, which also keeps its sessions there. Always taken. */
export const DATA_DATABASES = ["opencode-local.db"]
/** The conversation history; left out with --sem-historico. */
export const HISTORY_DATABASES = ["opencode-dev.db"]

/** The desktop app's preference files; caches, logs and cookies stay behind. */
export const APP_FILE = /^(opencode\..+\.dat|opencode\.global\.dat|opencode\.settings|default\.dat)$/
export const APP_DATABASES = ["drafts.sqlite"]
export const APP_FOLDERS = [path.join("Local Storage", "leveldb")]

/**
 * User environment variables that hold keys the app reads. Taken from the
 * user's registry scope, since the process that exports may have been started
 * before one was set.
 */
export const ENV = /(_API_KEY|_TOKEN)$|^OPENCODE_BROWSER_/

/** Text files whose paths may name the old PC's user folder. */
export const TEXT = /\.(json|jsonc|dat|settings|md|mjs|js|ts|txt|toml|yaml|yml)$/i

/**
 * Points paths under the other PC's user folder at this one's, in each
 * spelling a file may hold them: plain, escaped inside JSON, and with forward
 * slashes. Only the whole folder name is matched, so C:\Users\ana is not found
 * inside C:\Users\anabela.
 */
export function relocate(text: string, from: string, to: string) {
  const spellings = (value: string) => [value, value.replaceAll("\\", "\\\\"), value.replaceAll("\\", "/")]
  const sources = spellings(path.win32.resolve(from))
  const targets = spellings(path.win32.resolve(to))
  sources.forEach((source, index) => {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    text = text.replace(new RegExp(`${escaped}(?=[\\\\/"'\\s]|$)`, "gi"), () => targets[index]!)
  })
  return text
}
