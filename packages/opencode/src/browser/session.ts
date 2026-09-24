import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import path from "path"
import { Context, Effect, Layer } from "effect"
import open from "open"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { CDPConnection } from "./cdp"
import { BrowserInstall, type LaunchTarget } from "./install"
import { BrowserBridge, type Bridge, type BridgeTarget, type TargetEvent } from "./bridge"
import { BrowserPdf } from "./pdf"
import { asRecord, asText, type CreateTargetResult, type TargetInfo, type VersionInfo } from "./protocol"
import { Tab, type Activity, type Frame, type TabHooks, type UserInput } from "./tab"

export type { Activity, ConsoleEntry, Frame, NetworkEntry, UserInput } from "./tab"

export interface TabInfo {
  id: string
  url: string
  title: string
  active: boolean
}

export interface Status {
  running: boolean
  /** How the agent drives the browser, so the live view can prompt for pairing in extension mode. */
  mode: "process" | "extension"
  browser?: string
  headless: boolean
  url?: string
  title?: string
  tabs: TabInfo[]
  /** The person's own browser, where blocked sites are handed over. Absent means the system default. */
  external?: string
}

/** How a page went to the person's own browser. Handing over never fails; it reports. */
export interface Handoff {
  /** The browser the page went to; `undefined` is the system's default one. */
  browser?: string
  /** False when no tab was opened: refused, failed, or handed over moments ago already. */
  opened: boolean
  error?: string
}

/** What the live view receives while it is connected. */
export type BrowserEvent =
  | { type: "status"; status: Status }
  | { type: "frame"; frame: Frame }
  | { type: "activity"; activity: Activity }

export type Listener = (event: BrowserEvent) => void

/** What the person watching can do from the live view's toolbar. */
export type Command =
  | { action: "navigate"; url: string }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "new_tab"; url?: string }
  | { action: "select_tab"; tab: string }
  | { action: "close_tab"; tab: string }
  | { action: "resize"; width: number; height: number }
  | { action: "open_external" }

/** Bounds for the viewport the live view asks for, whatever size its pane is. */
const VIEWPORT_MIN = { width: 320, height: 240 }
const VIEWPORT_MAX = { width: 2560, height: 1600 }
/**
 * Streamed pictures are capped at the pane's size with some headroom for dense
 * screens: a window larger than the pane would otherwise send pixels nobody
 * sees, and through the extension they share one socket with every command.
 */
const CAST_HEADROOM = 1.5
/** How long the live view waits for a still page's first picture before the stream's own. */
const FIRST_FRAME_WAIT = 3000

const DEFAULT_TIMEOUT = 30_000
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
/** How long the agent waits for a paired extension that is between sockets; it retries every few seconds. */
const EXTENSION_WAIT = 10_000
/** How long to wait for the browser to publish its debugging port. */
const STARTUP_TIMEOUT = 30_000
/** Navigations fire several events in a burst; the address bar needs one update. */
const STATUS_DEBOUNCE = 120
/** A site handed over automatically is not handed over again this soon, so a looping agent opens one tab, not ten. */
const HANDOFF_REPEAT = 10 * 60_000
/** How long a browser being started for a handoff gets to report a failure. */
const HANDOFF_START = 3000

/**
 * Ad, tracker and analytics hosts, failed in the tabs the agent drives. They
 * keep a page loading and its network busy after it is readable, which the
 * wait after each action counts. Nothing a page needs to work is on it.
 */
const BLOCKED_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adservice.google.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "connect.facebook.net",
  "amazon-adsystem.com",
  "adnxs.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "scorecardresearch.com",
  "quantserve.com",
  "hotjar.com",
  "clarity.ms",
  "mc.yandex.ru",
  "bat.bing.com",
  "analytics.tiktok.com",
  "ads.linkedin.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "smartadserver.com",
  "moatads.com",
  "adsrvr.org",
  "nr-data.net",
].flatMap((host) => [host, `*.${host}`])

interface State {
  process?: ChildProcess
  connection?: CDPConnection
  endpoint?: string
  label?: string
  headless: boolean
  /** Whether tabs fail requests to `BLOCKED_HOSTS`. */
  block: boolean
  timeout: number
  viewport: { width: number; height: number }
  profileDir: string
  options: { channel?: string; executablePath?: string; external?: string; mode?: "process" | "extension" }
  /** "process" launches our own browser; "extension" drives the user's via the bridge. */
  mode: "process" | "extension"
  bridge?: Bridge
  /** Unsubscribes from the bridge's tab and connection events. */
  unbridge?: () => void
  /** Every tab the extension sees, so the agent can list and switch to any of them. */
  targets: BridgeTarget[]
  /** Resolved once: looking for binaries on every status update would be wasteful. */
  external?: LaunchTarget
  /** When each host was last handed over. */
  handed: Map<string, number>
  tabs: Map<string, Tab>
  /** Attachments in flight, so a tab reported twice is only attached once. */
  attaching: Map<string, Promise<Tab>>
  /** Per tab that opened another (by target id), the tab it opened last and when. */
  popups: Map<string, { tab: string; at: number }>
  active?: string
  counter: number
  listeners: Set<Listener>
  /** The tab currently being streamed to the live view. */
  cast?: string
  /** The recast in progress; later requests wait for it and run once more after. */
  recasting?: Promise<void>
  recastAgain?: boolean
  recastRestart?: boolean
  statusTimer?: ReturnType<typeof setTimeout>
  /** The last status sent to the live view, so an unchanged one is not sent again. */
  announced?: string
  /**
   * The live view's size. It caps the pictures that are streamed to it and
   * nothing else: the page is laid out at {@link State.viewport}, whatever the
   * pane's shape, so dragging the pane's edge cannot relayout a page the agent
   * is in the middle of working on, and the same site behaves the same on
   * every screen. The pane scales what it receives to fit.
   */
  fit?: { width: number; height: number }
}

export interface Interface {
  /** The active tab, starting the browser on first use. */
  readonly tab: () => Effect.Effect<Tab>
  /**
   * The active tab only if the browser is already running.
   *
   * The live view asks through this rather than through `tab()`, because
   * looking at the browser must never be what starts one.
   */
  readonly current: () => Effect.Effect<Tab | undefined>
  /** Opens a new tab and makes it active. */
  readonly open: (url?: string) => Effect.Effect<Tab>
  readonly tabs: () => Effect.Effect<TabInfo[]>
  readonly select: (id: string) => Effect.Effect<Tab>
  readonly close: (id: string) => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status>
  /** Closes the browser. The next call to `tab()` starts a fresh one. */
  readonly shutdown: () => Effect.Effect<void>
  readonly timeout: () => Effect.Effect<number>
  /**
   * Streams status, frames and agent activity to a live view. While anyone is
   * subscribed the active tab is screencast and the agent acts at a visible
   * pace. Returns the unsubscribe function.
   */
  readonly subscribe: (listener: Listener) => Effect.Effect<() => void>
  /** Runs a toolbar command from the live view, starting the browser if needed. */
  readonly control: (command: Command) => Effect.Effect<Status>
  /** Forwards mouse and keyboard input from the live view to the active tab. */
  readonly input: (event: UserInput) => Effect.Effect<void>
  /**
   * Opens a page in the person's own browser, with their everyday profile.
   * The tab it opens is theirs: the agent can neither see nor drive it. With
   * `once`, a host handed over in the last few minutes is not opened again.
   */
  readonly handoff: (url: string, options?: { once?: boolean }) => Effect.Effect<Handoff>
  /** Whether this session launches its own browser or drives the person's through the extension. */
  readonly mode: () => Effect.Effect<"process" | "extension">
  /**
   * Takes a tab back from a PDF it landed on, to the page it was on, so the
   * agent can carry on there. Driving the person's own browser this is also
   * how the agent gets the tab back, since the browser's PDF viewer throws the
   * debugger off. Resolves to whether the tab is drivable again.
   */
  readonly leavePdf: (tab: Tab) => Effect.Effect<boolean>
  /**
   * The tab `opener` opened since `since` (a target=_blank link, a popup), once
   * it is attached and active, waiting up to `wait` ms for one to show up.
   */
  readonly opened: (opener: Tab, since: number, wait: number) => Effect.Effect<Tab | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Browser") {}

export class BrowserStartError extends Error {
  constructor(detail: string) {
    super(
      [
        `Could not start the browser: ${detail}`,
        "If a previous browser is still running with the same profile, close it and try again,",
        "or set browser.profile in your opencode config to use a separate profile.",
      ].join("\n"),
    )
    this.name = "BrowserStartError"
  }
}

/**
 * Why a tab of the person's browser could not be attached, in terms the agent
 * can act on: the browser keeps extensions off its PDF viewer and its own pages.
 */
function attachError(s: State, targetId: string, error: unknown) {
  const url = s.targets.find((t) => t.targetId === targetId)?.url ?? ""
  const reason = error instanceof Error ? error.message : String(error)
  if (BrowserPdf.looksLikePdf(url) || /pdf/i.test(reason)) {
    return new Error(
      `Tab ${targetId} shows a PDF (${url || "unknown address"}), which the browser does not let extensions drive. To read it, call browser_navigate with its URL: PDFs are downloaded and read directly.`,
    )
  }
  if (/^(chrome|brave|edge|about|devtools|chrome-extension):/i.test(url) || /chrome-extension:\/\//i.test(reason)) {
    return new Error(`Tab ${targetId} shows a browser page (${url}), which extensions may not drive. Use another tab.`)
  }
  return error instanceof Error ? error : new Error(reason)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPort(profileDir: string, child: ChildProcess) {
  const portFile = path.join(profileDir, "DevToolsActivePort")
  const read = () => {
    try {
      return fs.readFileSync(portFile, "utf8").split("\n")[0]?.trim() || undefined
    } catch {
      return undefined
    }
  }

  const deadline = Date.now() + STARTUP_TIMEOUT
  while (Date.now() < deadline) {
    const port = read()
    if (port) return port
    // Some builds hand off to a second process and let the first one exit, so
    // an exited child is only a failure when no port was published with it.
    if (child.exitCode !== null) {
      await sleep(500)
      const handed = read()
      if (handed) return handed
      throw new BrowserStartError(`the browser exited with code ${child.exitCode}`)
    }
    await sleep(100)
  }
  throw new BrowserStartError("it did not publish a debugging port in time")
}

/**
 * Starts a browser the way clicking a link would: no flags, its own profile,
 * and detached, so it outlives opencode. With the browser already open this
 * only adds a tab to it. Resolves to the reason it failed, if it did.
 */
function startPlain(executable: string, url: string) {
  return new Promise<string | undefined>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(executable, [url], { detached: true, stdio: "ignore" })
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error))
      return
    }
    const timer = setTimeout(() => resolve(undefined), HANDOFF_START)
    child.once("spawn", () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      resolve(error.message)
    })
    child.unref()
  })
}

/** Opens a page in the system's default browser. Resolves to the reason it failed, if it did. */
async function openDefault(url: string) {
  try {
    const child = await open(url)
    child.on("error", () => {})
    child.unref()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function deliver(external: LaunchTarget | undefined, url: string): Promise<Handoff> {
  if (external?.executablePath) {
    const failure = await startPlain(external.executablePath, url)
    if (!failure) return { browser: external.label, opened: true }
    // A browser that will not start still leaves the default one.
    if (!(await openDefault(url))) return { opened: true }
    return { browser: external.label, opened: false, error: failure }
  }
  const failure = await openDefault(url)
  return failure ? { opened: false, error: failure } : { opened: true }
}

/**
 * Turns what someone typed into the address bar into a URL. Like any browser,
 * something that is not recognisably an address becomes a search.
 */
export function addressToUrl(input: string) {
  const text = input.trim()
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) || text.startsWith("about:")) return text
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const bridgeService = yield* BrowserBridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("Browser.state")(function* () {
        const cfg = yield* config.get()
        const options = cfg.browser ?? {}
        const bridge = yield* bridgeService.get()

        const mode = options.mode ?? "process"
        const s: State = {
          // The person's own browser is a window on their screen, so the agent
          // always has an audience there: its cursor shows whether or not the
          // live view is open.
          headless: mode === "extension" ? false : (options.headless ?? true),
          block: options.block ?? true,
          timeout: options.timeout ?? DEFAULT_TIMEOUT,
          viewport: {
            width: options.viewport?.width ?? DEFAULT_VIEWPORT.width,
            height: options.viewport?.height ?? DEFAULT_VIEWPORT.height,
          },
          profileDir: path.join(Global.Path.data, "browser", options.profile ?? "default"),
          options,
          external: BrowserInstall.external(options),
          mode,
          bridge,
          targets: [],
          handed: new Map(),
          tabs: new Map(),
          attaching: new Map(),
          popups: new Map(),
          counter: 0,
          listeners: new Set(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            s.listeners.clear()
            await teardown(s)
          }),
        )
        return s
      }),
    )

    /** Whether a browser is currently driveable, whichever transport backs it. */
    function live(s: State) {
      return s.mode === "extension" ? s.bridge?.connected === true : s.connection?.connected === true
    }

    /**
     * Whether this session has wired its browser up, not merely that a transport
     * exists. The extension can be connected before we have adopted its tabs and
     * subscribed to its events, so "connected" is not enough to skip setup.
     */
    function ready(s: State) {
      if (s.mode === "extension") return s.bridge?.connected === true && s.unbridge !== undefined
      return s.connection?.connected === true
    }

    function emit(s: State, event: BrowserEvent) {
      for (const listener of s.listeners) {
        try {
          listener(event)
        } catch {
          // One broken viewer must not take the others down.
        }
      }
    }

    async function statusOf(s: State): Promise<Status> {
      if (!live(s)) return { running: false, mode: s.mode, headless: s.headless, tabs: [] }
      if (s.mode === "extension") {
        // Set up tab tracking the moment anyone looks, so the panel lists the
        // browser's tabs before the agent has acted.
        await trackExtension(s)
        // The tab list is every tab in the user's browser, not only the ones the
        // agent has attached to, so it can pick any of them.
        const activeId = s.active ?? s.targets.find((t) => t.active)?.targetId
        const tabs = s.targets.map((t) => ({
          id: t.targetId,
          url: t.url,
          title: t.title,
          active: t.targetId === activeId,
        }))
        const active = tabs.find((t) => t.active)
        return {
          running: true,
          mode: s.mode,
          browser: s.label,
          headless: s.headless,
          url: active?.url,
          title: active?.title,
          tabs,
          external: s.external?.label,
        }
      }
      const list = await Promise.all(
        [...s.tabs.values()].map(async (item) => ({
          id: item.id,
          url: await item.url(),
          title: await item.title(),
          active: item.id === s.active,
        })),
      )
      const active = list.find((item) => item.active)
      return {
        running: true,
        mode: s.mode,
        browser: s.label,
        headless: s.headless,
        url: active?.url,
        title: active?.title,
        tabs: list,
        external: s.external?.label,
      }
    }

    function announceStatus(s: State) {
      if (s.listeners.size === 0) return
      if (s.statusTimer) clearTimeout(s.statusTimer)
      s.statusTimer = setTimeout(() => {
        s.statusTimer = undefined
        void statusOf(s).then((status) => {
          // The person's own browser reports a title or address change for
          // every tab in it, most of which leave this status exactly as it was.
          // Sending it again would have the pane rebuild its tab strip for
          // nothing, which with a browser full of tabs is felt.
          const serialized = JSON.stringify(status)
          if (serialized === s.announced) return
          s.announced = serialized
          emit(s, { type: "status", status })
        })
      }, STATUS_DEBOUNCE)
    }

    function hooksFor(s: State): TabHooks {
      return {
        // A visible window is an audience too.
        presenting: () => s.listeners.size > 0 || !s.headless,
        watched: () => s.listeners.size > 0,
        activity: (activity) => emit(s, { type: "activity", activity }),
        changed: () => announceStatus(s),
      }
    }

    function castSize(s: State) {
      if (!s.fit) return undefined
      return {
        width: Math.min(VIEWPORT_MAX.width, Math.round(s.fit.width * CAST_HEADROOM)),
        height: Math.min(VIEWPORT_MAX.height, Math.round(s.fit.height * CAST_HEADROOM)),
      }
    }

    /**
     * Streams the active tab while anyone watches, and nothing otherwise.
     * `restart` streams it afresh, for when the pane changed size.
     */
    function recast(s: State, restart = false): Promise<void> {
      // One at a time. Status changes, resizes and viewers coming and going each
      // ask for one, and when the browser was slow to answer they used to pile
      // up by the hundred, every one stopping and restarting the stream.
      s.recastRestart ||= restart
      if (s.recasting) {
        s.recastAgain = true
        return s.recasting
      }
      const run = async () => {
        do {
          s.recastAgain = false
          const again = s.recastRestart === true
          s.recastRestart = false
          await castOnce(s, again).catch(() => {})
        } while (s.recastAgain)
      }
      s.recasting = run().finally(() => {
        s.recasting = undefined
      })
      return s.recasting
    }

    async function castOnce(s: State, restart: boolean) {
      const wanted = s.listeners.size > 0 && live(s) ? s.active : undefined
      if (s.cast === wanted && !restart) return
      const previous = s.cast ? s.tabs.get(s.cast) : undefined
      s.cast = wanted
      // Not waited for: the stream's frames stop here at once, and a tab the
      // browser is not painting may never confirm, which held up the next start.
      if (previous?.connected) void previous.stopScreencast()
      const next = wanted ? s.tabs.get(wanted) : undefined
      if (!next?.connected) return
      await next.startScreencast((frame) => {
        if (s.cast === next.id) emit(s, { type: "frame", frame })
      }, castSize(s))
      // Chromium only sends frames on change, so a still page needs one sent by
      // hand; a tab that is not being painted never gives one, so not for long.
      const first = await Promise.race([next.frame(), sleep(FIRST_FRAME_WAIT).then(() => undefined)]).catch(() => undefined)
      if (first && s.cast === next.id) emit(s, { type: "frame", frame: first })
    }

    function changed(s: State) {
      announceStatus(s)
      void recast(s).catch(() => {})
    }

    async function teardown(s: State) {
      if (s.statusTimer) clearTimeout(s.statusTimer)
      s.cast = undefined
      // The extension owns the browser process and lives on across sessions;
      // shutting down just means we stop tracking its tabs, not closing it.
      if (s.mode === "extension") {
        s.unbridge?.()
        s.unbridge = undefined
        for (const tab of s.tabs.values()) tab.close()
        s.tabs.clear()
        s.attaching.clear()
        s.targets = []
        s.active = undefined
        emit(s, { type: "status", status: { running: false, mode: s.mode, headless: s.headless, tabs: [] } })
        return
      }
      for (const tab of s.tabs.values()) tab.close()
      s.tabs.clear()
      s.attaching.clear()
      s.active = undefined
      const connection = s.connection
      const child = s.process
      s.connection = undefined
      s.process = undefined
      s.endpoint = undefined
      if (connection?.connected) {
        // Asking the browser to close lets it flush the profile, but a browser
        // that will not answer must never stall opencode's own shutdown.
        await Promise.race([connection.send("Browser.close").catch(() => {}), sleep(2000)])
        connection.close()
      }
      // The profile directory stays locked until the process is really gone,
      // and the next launch would fail on that lock, so wait it out here.
      if (child) {
        const deadline = Date.now() + 5000
        while (child.exitCode === null && Date.now() < deadline) {
          await sleep(100)
          if (child.exitCode === null && Date.now() > deadline - 3000) child.kill()
        }
      }
      emit(s, { type: "status", status: { running: false, mode: s.mode, headless: s.headless, tabs: [] } })
    }

    /** Attaches to a page target once, however many times it is reported. */
    function adopt(s: State, targetId: string) {
      const known = [...s.tabs.values()].find((item) => item.targetId === targetId)
      if (known) return Promise.resolve(known)
      const pending = s.attaching.get(targetId)
      if (pending) return pending
      const open =
        s.mode === "extension"
          ? (async () => {
              const connection = s.bridge!.connection(targetId)
              try {
                await connection.connect()
                return await Tab.attachTransport(targetId, targetId, connection, hooksFor(s))
              } catch (error) {
                // A transport that never came up must not be handed out again.
                connection.close()
                throw attachError(s, targetId, error)
              }
            })()
          : Tab.attach(
              `tab_${++s.counter}`,
              targetId,
              `${s.endpoint!.replace(/^http/, "ws")}/devtools/page/${targetId}`,
              hooksFor(s),
            )
      const attached = open
        .then(async (tab) => {
          // Every tab lays out at its own window's size and nothing else: the
          // browser we launch is opened at the configured viewport, and the
          // person's own window is theirs. The pane scales what it is sent.
          // This also undoes an emulated size a previous version forced on it,
          // which is worth doing on a browser we reconnected to.
          await tab.clearResize()
          if (s.block) await tab.block(BLOCKED_HOSTS)
          s.tabs.set(tab.id, tab)
          return tab
        })
        .finally(() => s.attaching.delete(targetId))
      s.attaching.set(targetId, attached)
      return attached
    }

    /** Reacts to tabs opened, closed or focused in the user's own browser. */
    /**
     * Takes over a tab a site opened from one of ours and makes it active, the
     * way a browser focuses it, and remembers which tab opened it so the action
     * that did it can report where it went.
     */
    function follow(s: State, targetId: string, opener: string, at: number) {
      return adopt(s, targetId)
        .then((tab) => {
          s.active = tab.id
          s.popups.set(opener, { tab: tab.id, at })
          changed(s)
        })
        .catch(() => {})
    }

    function onBridgeTarget(s: State, event: TargetEvent) {
      const { targetId, url, title, active } = event.target
      // A tab opened by one the agent drives (a target=_blank link, a popup)
      // is where its click went, as in the launched browser.
      const opener = event.target.opener
      if (event.event === "created" && opener && [...s.tabs.values()].some((tab) => tab.targetId === opener)) {
        void follow(s, targetId, opener, Date.now())
      }
      if (event.event === "removed") {
        s.targets = s.targets.filter((t) => t.targetId !== targetId)
        const gone = [...s.tabs.values()].find((tab) => tab.targetId === targetId)
        if (gone) {
          gone.close()
          s.tabs.delete(gone.id)
          if (s.active === gone.id) s.active = s.tabs.keys().next().value
        }
        changed(s)
        return
      }
      if (event.event === "activated") {
        // The person focused a tab in their browser; reflect it in the list. The
        // agent's own active tab is not moved unless it is asked to switch.
        s.targets = s.targets.map((t) => ({ ...t, active: t.targetId === targetId }))
        announceStatus(s)
        return
      }
      // Created or updated: refresh the cached entry (attaching to a tab the agent
      // is not driving would badge it, so tabs are only attached on demand).
      const entry = { targetId, url: url ?? "", title: title ?? "", active: active === true }
      const at = s.targets.findIndex((t) => t.targetId === targetId)
      if (at >= 0) s.targets[at] = { ...s.targets[at], ...entry }
      else s.targets.push(entry)
      announceStatus(s)
    }

    /**
     * Subscribes to the extension's tabs and caches them, so the browser's tab
     * list is known whether or not the agent has acted. Idempotent and does not
     * attach to any tab; attaching happens on demand when a tab is driven.
     */
    async function trackExtension(s: State) {
      const bridge = s.bridge
      if (!bridge?.connected || s.unbridge) return
      const offTarget = bridge.onTarget((event) => onBridgeTarget(s, event))
      const offState = bridge.onState(() => {
        if (bridge.connected)
          void trackExtension(s)
            .then(() => changed(s))
            .catch(() => {})
        else void teardown(s)
      })
      s.unbridge = () => {
        offTarget()
        offState()
      }
      s.targets = await bridge.listTargets().catch(() => [])
    }

    async function launch(s: State) {
      const target = BrowserInstall.resolve(s.options)
      const executable = target.executablePath
      if (!executable) throw new BrowserStartError(`no executable found for ${target.label}`)

      fs.mkdirSync(s.profileDir, { recursive: true })
      const portFile = path.join(s.profileDir, "DevToolsActivePort")

      // opencode may have been killed without closing its browser, which then
      // keeps the profile locked and makes a fresh start fail. If that browser
      // still answers, carry on with it, tabs and all.
      const previous = (() => {
        try {
          return fs.readFileSync(portFile, "utf8").split("\n")[0]?.trim() || undefined
        } catch {
          return undefined
        }
      })()
      if (previous) {
        const alive = await fetch(`http://127.0.0.1:${previous}/json/version`, { signal: AbortSignal.timeout(1500) })
          .then((response) => (response.ok ? (response.json() as Promise<VersionInfo>) : undefined))
          .catch(() => undefined)
        if (alive) {
          s.label = target.label
          await connect(s, previous, alive)
          return
        }
      }
      // Otherwise the file is stale and would be read as the new browser's port.
      fs.rmSync(portFile, { force: true })

      const args = [
        "--remote-debugging-port=0",
        `--user-data-dir=${s.profileDir}`,
        `--window-size=${s.viewport.width},${s.viewport.height}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=Translate,AutoDeElevate,OptimizationHints",
        "--disable-search-engine-choice-screen",
        // Without this, Edge relaunches itself through its compatibility layer
        // and the process spawned here exits immediately.
        "--edge-skip-compat-layer-relaunch",
        ...(s.headless ? ["--headless=new"] : []),
        "about:blank",
      ]

      // A browser that was just closed can still hold the profile lock, and
      // Chromium answers that by exiting straight away rather than waiting, so
      // a start that fails fast is worth retrying before giving up.
      let port: string | undefined
      let failure: unknown
      for (let attempt = 0; attempt < 3 && port === undefined; attempt++) {
        if (attempt > 0) await sleep(700)
        const child = spawn(executable, args, { stdio: "ignore", windowsHide: true })
        // The browser must not keep opencode's event loop alive on its own.
        child.unref()
        child.on("error", () => {})
        s.process = child
        s.label = target.label
        try {
          port = await waitForPort(s.profileDir, child)
        } catch (error) {
          failure = error
        }
      }
      if (port === undefined) throw failure ?? new BrowserStartError("it did not start")
      const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
        response.json(),
      )) as VersionInfo
      await connect(s, port, version)
    }

    /** Takes control of a running browser: its events, and every tab it has open. */
    async function connect(s: State, port: string, version: VersionInfo) {
      s.endpoint = `http://127.0.0.1:${port}`
      const connection = new CDPConnection(version.webSocketDebuggerUrl)
      await connection.connect()
      s.connection = connection

      // Pages opened by sites, such as target=_blank links and popups, become
      // tabs like any other and take focus, as they would in a normal browser.
      connection.on("Target.targetCreated", (params) => {
        const info = asRecord(params["targetInfo"])
        if (asText(info["type"]) !== "page" || !asText(info["openerId"])) return
        void follow(s, asText(info["targetId"]), asText(info["openerId"]), Date.now())
      })
      // Title changes and single page app navigations (pushState) never fire a
      // load event, but they do change the target, which is what the address
      // bar and tab titles follow.
      connection.on("Target.targetInfoChanged", () => announceStatus(s))
      connection.on("Target.targetDestroyed", (params) => {
        const targetId = asText(params["targetId"])
        const gone = [...s.tabs.values()].find((item) => item.targetId === targetId)
        if (!gone) return
        gone.close()
        s.tabs.delete(gone.id)
        if (s.active === gone.id) s.active = s.tabs.keys().next().value
        changed(s)
      })
      await connection.send("Target.setDiscoverTargets", { discover: true }).catch(() => {})

      // Adopt whatever the browser has open, so the first navigation reuses a
      // tab instead of leaving a blank one behind.
      const targets = (await fetch(`${s.endpoint}/json/list`).then((response) => response.json())) as TargetInfo[]
      for (const entry of targets.filter((item) => item.type === "page")) await adopt(s, entry.id)
      s.active = s.tabs.keys().next().value
    }

    async function newTab(s: State, url = "about:blank") {
      const targetId =
        s.mode === "extension"
          ? await s.bridge!.createTarget(url)
          : (await s.connection!.send<CreateTargetResult>("Target.createTarget", { url })).targetId
      const tab = await adopt(s, targetId)
      s.active = tab.id
      if (s.mode === "extension" && !s.targets.some((t) => t.targetId === targetId)) {
        s.targets.push({ targetId, url, title: "", active: true })
      }
      changed(s)
      return tab
    }

    const ensure = Effect.fn("Browser.ensure")(function* () {
      const s = yield* InstanceState.get(state)
      if (s.mode === "extension") {
        // The extension is the browser; if it is not paired there is nothing to
        // drive, and this must never fall back to launching one. It is often
        // only between sockets, though: its worker restarted, or it was turned
        // away before this server knew the pairing token (set just now, when
        // this state was built), and it retries within a few seconds.
        const bridge = s.bridge
        if (bridge && !bridge.connected && bridge.paired) {
          yield* Effect.promise(() => bridge.whenConnected(EXTENSION_WAIT).catch(() => {}))
        }
        if (!s.bridge?.connected) {
          yield* Effect.die(
            new BrowserStartError(
              "the OpenCode Browser Bridge extension is not connected. Open the browser panel to see the port, load the extension, and pair it (set browser.extensionToken and enter it in the extension popup).",
            ),
          )
        }
        yield* Effect.promise(() => trackExtension(s))
      } else if (!ready(s)) {
        if (s.process || s.connection) yield* Effect.promise(() => teardown(s))
        yield* Effect.tryPromise({
          try: () => launch(s),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.orDie)
        changed(s)
      }
      // Tabs the user or the site closed, or that the browser took out of
      // reach, are let go properly, so attaching to them again starts afresh.
      for (const [id, item] of s.tabs) {
        if (item.connected) continue
        item.close()
        s.tabs.delete(id)
      }
      if (s.active && !s.tabs.has(s.active)) s.active = undefined
      if (!s.active) {
        const existing = [...s.tabs.values()].find((tab) => tab.connected)
        if (existing) {
          s.active = existing.id
          changed(s)
        } else if (s.mode === "extension") {
          // Reuse the tab the person is on rather than opening a blank one.
          // One the debugger may not attach to (a PDF, a browser page) must
          // not leave the agent stuck: it gets a tab of its own instead.
          const target = s.targets.find((t) => t.active) ?? s.targets[0]
          const adopted = target
            ? yield* Effect.promise(() => adopt(s, target.targetId).catch(() => undefined))
            : undefined
          if (adopted) {
            s.active = adopted.id
            changed(s)
          } else yield* Effect.promise(() => newTab(s))
        } else yield* Effect.promise(() => newTab(s))
      }
      return s
    })

    const tab: Interface["tab"] = Effect.fn("Browser.tab")(function* () {
      const s = yield* ensure()
      return s.tabs.get(s.active!)!
    })

    const current: Interface["current"] = Effect.fn("Browser.current")(function* () {
      const s = yield* InstanceState.get(state)
      if (!live(s) || !s.active) return undefined
      const found = s.tabs.get(s.active)
      return found?.connected ? found : undefined
    })

    const open: Interface["open"] = Effect.fn("Browser.open")(function* (url?: string) {
      const s = yield* ensure()
      return yield* Effect.promise(() => newTab(s, url))
    })

    const tabs: Interface["tabs"] = Effect.fn("Browser.tabs")(function* () {
      const s = yield* InstanceState.get(state)
      return (yield* Effect.promise(() => statusOf(s))).tabs
    })

    const select: Interface["select"] = Effect.fn("Browser.select")(function* (id: string) {
      const s = yield* ensure()
      let found = s.tabs.get(id)
      // In extension mode the id is a Brave tab that the agent may not have
      // attached to yet, so attach on demand before switching to it.
      if (!found && s.mode === "extension" && s.targets.some((t) => t.targetId === id)) {
        const attached = yield* Effect.promise(() =>
          adopt(s, id).then(
            (tab) => ({ tab }),
            (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
          ),
        )
        if ("error" in attached) return yield* Effect.die(attached.error)
        found = attached.tab
      }
      if (!found) return yield* Effect.die(new Error(`No open tab with id ${id}`))
      s.active = found.id
      yield* Effect.promise(() =>
        s.mode === "extension" ? s.bridge!.activateTarget(found!.targetId).catch(() => {}) : found!.bringToFront(),
      )
      changed(s)
      return found
    })

    const close: Interface["close"] = Effect.fn("Browser.close")(function* (id: string) {
      const s = yield* InstanceState.get(state)
      const found = s.tabs.get(id)
      if (s.mode === "extension") {
        // The id is a Brave tab; close it even if the agent never attached to it.
        found?.close()
        if (found) s.tabs.delete(id)
        s.targets = s.targets.filter((t) => t.targetId !== id)
        if (s.bridge?.connected) yield* Effect.promise(() => s.bridge!.closeTarget(id).catch(() => {}))
        if (s.active === id) s.active = s.tabs.keys().next().value
        changed(s)
        return
      }
      if (!found) return
      found.close()
      s.tabs.delete(id)
      if (s.connection?.connected) {
        yield* Effect.promise(() =>
          s.connection!.send("Target.closeTarget", { targetId: found.targetId }).catch(() => {}),
        )
      }
      if (s.active === id) s.active = s.tabs.keys().next().value
      changed(s)
    })

    const status: Interface["status"] = Effect.fn("Browser.status")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(() => statusOf(s))
    })

    const shutdown: Interface["shutdown"] = Effect.fn("Browser.shutdown")(function* () {
      const s = yield* InstanceState.get(state)
      yield* Effect.promise(() => teardown(s))
    })

    const timeout: Interface["timeout"] = Effect.fn("Browser.timeout")(function* () {
      const s = yield* InstanceState.get(state)
      return s.timeout
    })

    const subscribe: Interface["subscribe"] = Effect.fn("Browser.subscribe")(function* (listener: Listener) {
      const s = yield* InstanceState.get(state)
      s.listeners.add(listener)
      // A new viewer gets the current state and picture straight away, instead
      // of a blank view until the next change.
      void statusOf(s).then((status) => {
        if (s.listeners.has(listener)) listener({ type: "status", status })
      })
      const wasCasting = s.cast
      void recast(s)
        .then(async () => {
          const casting = wasCasting ? s.tabs.get(wasCasting) : undefined
          if (!casting?.connected || !s.listeners.has(listener)) return
          const frame = await casting.frame().catch(() => undefined)
          if (frame) listener({ type: "frame", frame })
        })
        .catch(() => {})
      return () => {
        s.listeners.delete(listener)
        void recast(s).catch(() => {})
      }
    })

    const control: Interface["control"] = Effect.fn("Browser.control")(function* (command: Command) {
      if (command.action === "resize") {
        const s = yield* InstanceState.get(state)
        const width = Math.round(Math.min(VIEWPORT_MAX.width, Math.max(VIEWPORT_MIN.width, command.width)))
        const height = Math.round(Math.min(VIEWPORT_MAX.height, Math.max(VIEWPORT_MIN.height, command.height)))
        // The pane repeats its size whenever its status changes; only a new
        // size is worth restarting the stream for.
        if (s.fit?.width === width && s.fit.height === height) return yield* status()
        s.fit = { width, height }
        // The pane's size says how large the pictures need to be, and nothing
        // more. Laying the page out at the pane's size instead meant a site
        // reflowed to a phone layout because someone narrowed a panel, and an
        // element could move out from under a click the agent had already
        // aimed. The page keeps the viewport it was configured with.
        if (s.cast) void recast(s, true).catch(() => {})
        return yield* status()
      }
      if (command.action === "new_tab") {
        const s = yield* ensure()
        yield* Effect.promise(() => newTab(s, command.url ? addressToUrl(command.url) : undefined))
        return yield* status()
      }
      if (command.action === "select_tab") {
        yield* select(command.tab)
        return yield* status()
      }
      if (command.action === "close_tab") {
        yield* close(command.tab)
        return yield* status()
      }
      if (command.action === "open_external") {
        // Hands over whatever is on screen. With nothing open there is nothing
        // to hand over, and this must not be what starts a browser.
        const active = yield* current()
        const url = active ? yield* Effect.promise(() => active.url()) : undefined
        if (url) yield* handoff(url)
        return yield* status()
      }

      // Toolbar navigation returns at once; the address bar follows the page
      // through status events instead of holding the request open.
      const active = yield* tab()
      if (command.action === "navigate") yield* Effect.promise(() => active.go(addressToUrl(command.url)))
      if (command.action === "back") yield* Effect.promise(() => active.step(-1))
      if (command.action === "forward") yield* Effect.promise(() => active.step(1))
      if (command.action === "reload") yield* Effect.promise(() => active.refresh())
      return yield* status()
    })

    const handoff: Interface["handoff"] = Effect.fn("Browser.handoff")(function* (
      url: string,
      options?: { once?: boolean },
    ) {
      const s = yield* InstanceState.get(state)
      const browser = s.external?.label
      const target = URL.canParse(url) ? new URL(url) : undefined
      // Only web pages leave: a file:// or javascript: URL handed to another
      // program is a way to run things, not to browse.
      if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) {
        return { browser, opened: false, error: "Only http:// and https:// pages can be opened in another browser." }
      }
      const last = s.handed.get(target.host)
      if (options?.once && last !== undefined && Date.now() - last < HANDOFF_REPEAT) return { browser, opened: false }
      const result = yield* Effect.promise(() => deliver(s.external, target.href))
      if (result.opened) s.handed.set(target.host, Date.now())
      return result
    })

    const mode: Interface["mode"] = Effect.fn("Browser.mode")(function* () {
      return (yield* InstanceState.get(state)).mode
    })

    const leavePdf: Interface["leavePdf"] = Effect.fn("Browser.leavePdf")(function* (tab: Tab) {
      const s = yield* InstanceState.get(state)
      if (s.mode === "process") {
        // The browser's own viewer keeps the tab drivable; it just has nothing
        // to act on. The page before usually comes back from the back/forward
        // cache, which fires no load event, so the wait follows the navigation.
        return yield* Effect.promise(async () => {
          const mark = tab.mark()
          const went = await tab.step(-1).then(
            () => true,
            () => false,
          )
          if (!went) return false
          await tab.settle(mark, s.timeout)
          return tab.pdf === undefined
        })
      }
      const bridge = s.bridge
      if (!bridge?.connected) return false
      const pdf = tab.pdf
      // An extension from before this existed does not know the request.
      const went = yield* Effect.promise(() =>
        bridge.goBack(tab.targetId).then(
          () => true,
          () => false,
        ),
      )
      if (!went) return false
      return yield* Effect.promise(async () => {
        // The tab stays out of reach until the page before replaces the PDF viewer.
        const showing = () => s.targets.find((t) => t.targetId === tab.targetId)?.url
        const deadline = Date.now() + 6000
        while (pdf && showing() === pdf && Date.now() < deadline) await sleep(150)
        tab.close()
        for (const [id, item] of s.tabs) if (item === tab) s.tabs.delete(id)
        for (let attempt = 0; attempt < 5; attempt++) {
          const adopted = await adopt(s, tab.targetId).catch(() => undefined)
          if (adopted) {
            s.active = adopted.id
            await adopted.quiet()
            changed(s)
            return true
          }
          await sleep(400)
        }
        return false
      })
    })

    const input: Interface["input"] = Effect.fn("Browser.input")(function* (event: UserInput) {
      const active = yield* current()
      if (!active) return
      yield* Effect.promise(() => active.input(event).catch(() => {}))
    })

    const opened: Interface["opened"] = Effect.fn("Browser.opened")(function* (
      opener: Tab,
      since: number,
      wait: number,
    ) {
      const s = yield* InstanceState.get(state)
      const find = () => {
        const popup = s.popups.get(opener.targetId)
        return popup && popup.at >= since ? s.tabs.get(popup.tab) : undefined
      }
      const deadline = Date.now() + wait
      while (!find() && Date.now() < deadline) yield* Effect.sleep(50)
      return find()
    })

    return Service.of({
      opened,
      tab,
      current,
      open,
      tabs,
      select,
      close,
      status,
      shutdown,
      timeout,
      subscribe,
      control,
      input,
      handoff,
      mode,
      leavePdf,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, BrowserBridge.node] })

export * as Browser from "./session"
