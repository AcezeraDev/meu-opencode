/**
 * The slice of the Chrome DevTools Protocol this browser uses.
 *
 * The protocol is far larger than what is needed here, and generated bindings
 * for all of it would be a dependency in their own right, so only the handful
 * of results and events the tools depend on are described. Everything else the
 * browser sends stays `unknown` and is narrowed where it is read.
 */

/** An entry of the `/json/list` endpoint: one attachable target. */
export interface TargetInfo {
  id: string
  type: string
  url: string
  title: string
  webSocketDebuggerUrl: string
}

/** The `/json/version` endpoint, which is how the browser endpoint is found. */
export interface VersionInfo {
  webSocketDebuggerUrl: string
}

export interface RemoteObject {
  value?: unknown
  description?: string
  type?: string
}

export interface ExceptionDetails {
  text?: string
  exception?: RemoteObject
}

export interface EvaluateResult {
  result?: RemoteObject
  exceptionDetails?: ExceptionDetails
}

export interface NavigateResult {
  errorText?: string
}

export interface NavigationHistory {
  currentIndex: number
  entries: { id: number; url: string }[]
}

export interface ScreenshotResult {
  data: string
}

export interface LayoutMetrics {
  cssContentSize?: { width: number; height: number }
  contentSize: { width: number; height: number }
}

export interface CreateTargetResult {
  targetId: string
}

/**
 * Every event a tab listens to. The browser extension relays only these, so a
 * busy page's flood of events nobody reads (`Network.dataReceived` and the like)
 * does not queue up in front of command replies on the one socket they share.
 * A listener added to `tab.ts` must be added here too.
 */
export const TAB_EVENTS = [
  "Input.dragIntercepted",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
  "Page.domContentEventFired",
  "Page.loadEventFired",
  "Page.screencastFrame",
  "Page.javascriptDialogOpening",
  "Page.downloadWillBegin",
] as const

/**
 * The fields each event is actually read for, so the extension can leave the
 * rest behind.
 *
 * A CDP event carries far more than this engine looks at: one
 * `Network.responseReceived` brings every response header, the timing
 * breakdown and the whole TLS certificate chain. Relayed in full, opening an
 * ordinary news site pushed 1.1 MB of events through the extension's single
 * socket in twelve seconds — the same socket a click and its reply have to get
 * through. Pruned to these fields it is 292 KB.
 *
 * The table travels with the attach request, so this file stays the one place
 * that says what the engine reads. An extension that does not understand it
 * relays everything, as before, and a field left out here is simply missing
 * where `tab.ts` reads it — so a new listener means a new entry, same as
 * {@link TAB_EVENTS}. Events with no entry are relayed whole.
 */
export const TAB_FIELDS: Record<string, readonly string[]> = {
  "Network.requestWillBeSent": ["requestId", "type", "request.method", "request.url"],
  "Network.responseReceived": ["requestId", "type", "frameId", "response.status", "response.url", "response.headers"],
  "Network.loadingFinished": ["requestId"],
  "Network.loadingFailed": ["requestId", "errorText"],
}

/** Narrowing helpers, so protocol payloads never reach `String()` untyped. */
export function asText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

export * as CDPProtocol from "./protocol"
