import fs from "fs"
import os from "os"
import path from "path"

/**
 * Finds a Chromium-based browser to drive.
 *
 * Downloading a browser costs ~150MB, so one that is already installed is
 * always preferred: Edge ships with Windows, and Chrome is common everywhere
 * else. A Chromium downloaded by Playwright is picked up too, for machines that
 * happen to have one, but nothing here depends on Playwright being installed.
 */
export interface LaunchTarget {
  /** Absolute path to the binary that gets started. */
  executablePath?: string
  /** Channel name, kept for reporting which browser was chosen. */
  channel?: string
  /** Human readable name for logs and tool output. */
  label: string
}

interface Candidate {
  label: string
  channel: string
  paths: string[]
}

function windowsCandidates(): Candidate[] {
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files"
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
  const localAppData = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local")
  return [
    {
      label: "Microsoft Edge",
      channel: "msedge",
      paths: [
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      ],
    },
    {
      label: "Google Chrome",
      channel: "chrome",
      paths: [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      ],
    },
  ]
}

function macCandidates(): Candidate[] {
  return [
    {
      label: "Google Chrome",
      channel: "chrome",
      paths: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    },
    {
      label: "Microsoft Edge",
      channel: "msedge",
      paths: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    },
    { label: "Chromium", channel: "chromium", paths: ["/Applications/Chromium.app/Contents/MacOS/Chromium"] },
  ]
}

function linuxCandidates(): Candidate[] {
  return [
    {
      label: "Google Chrome",
      channel: "chrome",
      paths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
    },
    {
      label: "Chromium",
      channel: "chromium",
      paths: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
    },
    { label: "Microsoft Edge", channel: "msedge", paths: ["/usr/bin/microsoft-edge"] },
  ]
}

function candidates(): Candidate[] {
  if (process.platform === "win32") return windowsCandidates()
  if (process.platform === "darwin") return macCandidates()
  return linuxCandidates()
}

/** Where Playwright keeps downloaded browsers, if one was ever downloaded here. */
function cacheDir() {
  const override = process.env["PLAYWRIGHT_BROWSERS_PATH"]
  if (override && override !== "0") return override
  if (process.platform === "win32")
    return path.join(process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local"), "ms-playwright")
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright")
  return path.join(os.homedir(), ".cache", "ms-playwright")
}

function relativeBinary() {
  if (process.platform === "win32") return path.join("chrome-win", "chrome.exe")
  if (process.platform === "darwin") return path.join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
  return path.join("chrome-linux", "chrome")
}

/** A Chromium previously downloaded by Playwright, if present. */
export function downloaded(): LaunchTarget | undefined {
  let entries: string[]
  try {
    entries = fs.readdirSync(cacheDir())
  } catch {
    return undefined
  }
  for (const entry of entries
    .filter((item) => item.startsWith("chromium-"))
    .sort()
    .reverse()) {
    const executable = path.join(cacheDir(), entry, relativeBinary())
    if (fs.existsSync(executable)) return { executablePath: executable, channel: "chromium", label: "Chromium" }
  }
  return undefined
}

/** A stable browser already installed on this machine. */
export function installed(): LaunchTarget | undefined {
  for (const candidate of candidates()) {
    for (const executable of candidate.paths) {
      if (fs.existsSync(executable))
        return { executablePath: executable, channel: candidate.channel, label: candidate.label }
    }
  }
  return undefined
}

export class BrowserUnavailableError extends Error {
  constructor() {
    super(
      [
        "No Chromium-based browser was found on this machine.",
        "Install Microsoft Edge or Google Chrome, or set browser.executablePath in your opencode config",
        "to the path of any Chromium-based browser.",
      ].join("\n"),
    )
    this.name = "BrowserUnavailableError"
  }
}

export interface Options {
  channel?: string
  executablePath?: string
}

/** Picks which browser to start, most explicit first. */
export function resolve(options: Options = {}): LaunchTarget {
  const executablePath = options.executablePath ?? process.env["OPENCODE_BROWSER_EXECUTABLE"]
  if (executablePath) return { executablePath, label: path.basename(executablePath) }

  const channel = options.channel ?? process.env["OPENCODE_BROWSER_CHANNEL"]
  if (channel) {
    const match = candidates().find((candidate) => candidate.channel === channel)
    const executable = match?.paths.find((item) => fs.existsSync(item))
    if (!executable) throw new BrowserUnavailableError()
    return { executablePath: executable, channel, label: match!.label }
  }

  const found = installed() ?? downloaded()
  if (!found) throw new BrowserUnavailableError()
  return found
}

/** Where Brave installs itself, most common first. */
function braveCandidates(): string[] {
  if (process.platform === "win32") {
    const tail = path.join("BraveSoftware", "Brave-Browser", "Application", "brave.exe")
    return [
      process.env["ProgramFiles"] ?? "C:\\Program Files",
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local"),
    ].map((root) => path.join(root, tail))
  }
  if (process.platform === "darwin") return ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]
  return ["/usr/bin/brave-browser", "/usr/bin/brave", "/snap/bin/brave", "/opt/brave.com/brave/brave-browser"]
}

const KNOWN_NAMES: Record<string, string> = {
  brave: "Brave",
  "brave browser": "Brave",
  "brave-browser": "Brave",
  chrome: "Google Chrome",
  "google chrome": "Google Chrome",
  msedge: "Microsoft Edge",
  "microsoft edge": "Microsoft Edge",
  firefox: "Firefox",
  opera: "Opera",
  vivaldi: "Vivaldi",
}

/** A readable name for a browser binary, for the toolbar and the chat. */
function nameOf(executable: string) {
  const base = path.basename(executable).replace(/\.(exe|app)$/i, "")
  return KNOWN_NAMES[base.toLowerCase()] ?? base
}

/**
 * The person's own browser, where sites that turn the built-in one away are
 * handed over. It runs with their everyday profile, so it is started plainly:
 * no debugging port and no profile of ours. `undefined` means the system's
 * default browser.
 */
export function external(options: { external?: string } = {}): LaunchTarget | undefined {
  if (options.external) return { executablePath: options.external, label: nameOf(options.external) }
  const brave = braveCandidates().find((item) => fs.existsSync(item))
  if (brave) return { executablePath: brave, channel: "brave", label: "Brave" }
  return undefined
}

/** Whether any browser can be started, used to decide if the tools are offered. */
export function available(options: Options = {}) {
  if (options.executablePath ?? process.env["OPENCODE_BROWSER_EXECUTABLE"]) return true
  return installed() !== undefined || downloaded() !== undefined
}

export * as BrowserInstall from "./install"
