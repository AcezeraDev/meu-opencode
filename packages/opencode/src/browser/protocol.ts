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

/** Narrowing helpers, so protocol payloads never reach `String()` untyped. */
export function asText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

export * as CDPProtocol from "./protocol"
