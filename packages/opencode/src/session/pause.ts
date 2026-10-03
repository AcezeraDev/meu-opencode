import { Effect } from "effect"

/**
 * Pause and resume, kept in `session.metadata.paused` like the permission mode,
 * so the app sets it with the session update it already uses and the server
 * reads it live. While paused nothing new starts: no next model step, no next
 * tool call. A tool already running finishes. Resuming continues from exactly
 * there; cancelling still works while paused.
 */

const POLL = "300 millis"

export function isPaused(metadata: Record<string, unknown> | undefined) {
  return metadata?.["paused"] === true
}

/** Waits while `paused` says so, or until the call is cancelled. */
export const hold = (paused: Effect.Effect<boolean>, signal?: AbortSignal) =>
  Effect.gen(function* () {
    while (!signal?.aborted && (yield* paused)) yield* Effect.sleep(POLL)
  })

export * as SessionPause from "./pause"
