/// <reference lib="webworker" />

/**
 * Draws the live view's frames away from the app's main thread.
 *
 * Each frame is a JPEG of a few hundred kilobytes, as base64, arriving up to
 * twenty times a second. Turning that into bytes, decoding it and painting it
 * cost the main thread a quarter of its time on a page that animates, which is
 * felt as the whole app catching on every keystroke and scroll while the pane
 * is open. Here that work has a thread of its own, drawing straight into the
 * pane's canvas through `OffscreenCanvas`.
 *
 * Messages in: the canvas, frames, and a request to clear. Messages out:
 * `ready` once this script runs, so the page only hands its canvas over to a
 * worker that loaded, and `shown` whenever the page's viewport size changes,
 * which the page needs to map the pointer.
 *
 * Kept free of imports, so it is one self-contained script however the app is
 * bundled.
 */

type Incoming =
  | { type: "canvas"; canvas: OffscreenCanvas }
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "clear" }

type Frame = { data: string; width: number; height: number }

const scope = self as unknown as DedicatedWorkerGlobalScope

let canvas: OffscreenCanvas | undefined
let context: OffscreenCanvasRenderingContext2D | null = null
let decoding = false
let pending: Frame | undefined
/** The viewport last reported to the page; reset by a clear, so the next frame is reported again. */
let shown = { width: 0, height: 0 }

/** By hand: `Uint8Array.from(string, fn)` calls back into JavaScript once per byte. */
function bytes(base64: string) {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

/** Only the newest frame waits while one is decoding; the ones in between are never seen anyway. */
async function draw(frame: Frame) {
  if (decoding) {
    pending = frame
    return
  }
  decoding = true
  try {
    const bitmap = await createImageBitmap(new Blob([bytes(frame.data)], { type: "image/jpeg" }))
    if (canvas) {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
      }
      context ??= canvas.getContext("2d", { alpha: false })
      context?.drawImage(bitmap, 0, 0)
      const width = frame.width || bitmap.width
      const height = frame.height || bitmap.height
      if (width !== shown.width || height !== shown.height) {
        shown = { width, height }
        scope.postMessage({ type: "shown", width, height })
      }
    }
    bitmap.close()
  } catch {
    // A frame that fails to decode is simply skipped.
  } finally {
    decoding = false
    const next = pending
    pending = undefined
    if (next) void draw(next)
  }
}

scope.onmessage = (event: MessageEvent<Incoming>) => {
  const message = event.data
  if (message.type === "canvas") {
    canvas = message.canvas
    context = null
    return
  }
  if (message.type === "frame") {
    void draw(message)
    return
  }
  pending = undefined
  shown = { width: 0, height: 0 }
  if (canvas) {
    context ??= canvas.getContext("2d", { alpha: false })
    context?.clearRect(0, 0, canvas.width, canvas.height)
  }
}

scope.postMessage({ type: "ready" })
