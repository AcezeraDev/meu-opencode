export type Phase = "model" | "screenshot" | "observation" | "action" | "wait"

export interface Metrics {
  inputTokens?: number
  outputTokens?: number
  imageBytes?: number
}

export interface SpanMeta {
  phase: Phase
  proof?: string
  actionId?: string
  operationId?: string
}

export interface SpanContext {
  id: string
  setMetrics(values: Metrics): void
}

export interface SpanRecord extends Metrics {
  id: string
  phase: Phase
  startMs: number
  endMs: number
  status: "ok" | "error"
  proof?: string
  actionId?: string
  operationId?: string
}

export interface Trace {
  format: "lynx-trace-v1"
  sessionId: string
  clockAlignment: "session-relative" | "durations-only"
  spans: SpanRecord[]
  droppedSpans: number
}

export class LynxTelemetry {
  constructor(options: {
    sessionId: string
    sessionStartEpochMs?: number
    clockAlignment?: "session-relative" | "durations-only"
    maxSpans?: number
  })
  readonly sessionId: string
  readonly clockAlignment: "session-relative" | "durations-only"
  spans: SpanRecord[]
  dropped: number
  now(): number
  span<T>(meta: SpanMeta, operation: (context: SpanContext) => T | PromiseLike<T>): Promise<T>
  export(): Trace
  toJSON(): string
  save(filename: string): Promise<void>
}
