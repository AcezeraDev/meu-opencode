import type { BrowserFrame } from "./browser-feed"

/** The page's viewport in CSS pixels, as the frame being shown reports it. */
export type FrameViewport = { width: number; height: number }

export interface FramePainter {
  draw(frame: BrowserFrame): void
  /** Blanks the canvas; the next frame is reported through `onShown` again. */
  clear(): void
  dispose(): void
}

/**
 * How long a worker gets to say it loaded before the frames are drawn here
 * instead. It normally answers within a few milliseconds.
 */
const WORKER_START_MS = 3000

/**
 * Paints the live view's frames onto `canvas`, in a worker when the platform
 * allows it and on this thread otherwise.
 *
 * The canvas is only handed to the worker once the worker has said it is
 * running: a canvas given away cannot be drawn on here any more, so a worker
 * that failed to load would otherwise leave the pane black for good. Until
 * then only the newest frame is kept, and if the worker never answers the
 * frames are drawn here after all.
 */
export function createFramePainter(
  canvas: HTMLCanvasElement,
  onShown: (viewport: FrameViewport) => void,
): FramePainter {
  if (typeof Worker === "undefined" || typeof canvas.transferControlToOffscreen !== "function") {
    return paintHere(canvas, onShown)
  }

  let worker: Worker
  try {
    worker = new Worker(new URL("./frame-painter.worker.ts", import.meta.url), { type: "module" })
  } catch {
    return paintHere(canvas, onShown)
  }

  let state: "starting" | "worker" | "here" = "starting"
  let waiting: BrowserFrame | undefined
  let here: FramePainter | undefined

  const fallBack = () => {
    if (state !== "starting") return
    clearTimeout(timer)
    worker.terminate()
    state = "here"
    here = paintHere(canvas, onShown)
    if (waiting) here.draw(waiting)
    waiting = undefined
  }
  const timer = setTimeout(fallBack, WORKER_START_MS)

  worker.onmessage = (event: MessageEvent<{ type: string; width?: number; height?: number }>) => {
    const message = event.data
    if (message.type === "ready") {
      if (state !== "starting") return
      clearTimeout(timer)
      let offscreen: OffscreenCanvas
      try {
        offscreen = canvas.transferControlToOffscreen()
      } catch {
        // Already drawn on here, so it cannot be given away.
        fallBack()
        return
      }
      worker.postMessage({ type: "canvas", canvas: offscreen }, [offscreen])
      state = "worker"
      if (waiting) worker.postMessage({ type: "frame", ...waiting })
      waiting = undefined
      return
    }
    if (message.type === "shown") onShown({ width: message.width ?? 0, height: message.height ?? 0 })
  }
  worker.onerror = fallBack

  return {
    draw(frame) {
      if (state === "worker") worker.postMessage({ type: "frame", ...frame })
      else if (state === "here") here!.draw(frame)
      else waiting = frame
    },
    clear() {
      if (state === "worker") worker.postMessage({ type: "clear" })
      else if (state === "here") here!.clear()
      else waiting = undefined
    },
    dispose() {
      clearTimeout(timer)
      worker.terminate()
      here?.dispose()
    },
  }
}

/** By hand: `Uint8Array.from(string, fn)` calls back into JavaScript once per byte. */
function bytes(base64: string) {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

/**
 * The same painting on this thread, for where a worker cannot draw: no
 * `OffscreenCanvas`, or a worker that did not load.
 */
function paintHere(canvas: HTMLCanvasElement, onShown: (viewport: FrameViewport) => void): FramePainter {
  // Opaque, since every frame covers the whole surface, and desynchronized,
  // which lets the compositor show a picture without waiting for the rest of
  // the app's frame. Made once: a canvas answers every later `getContext` with
  // the context it already has, attributes and all.
  let context: CanvasRenderingContext2D | null = null
  const surface = () => (context ??= canvas.getContext("2d", { alpha: false, desynchronized: true }))
  let decoding = false
  let pending: BrowserFrame | undefined
  let shown: FrameViewport = { width: 0, height: 0 }
  let disposed = false

  const draw = async (frame: BrowserFrame) => {
    if (decoding) {
      pending = frame
      return
    }
    decoding = true
    try {
      const bitmap = await createImageBitmap(new Blob([bytes(frame.data)], { type: "image/jpeg" }))
      if (!disposed) {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width
          canvas.height = bitmap.height
        }
        surface()?.drawImage(bitmap, 0, 0)
        const width = frame.width || bitmap.width
        const height = frame.height || bitmap.height
        if (width !== shown.width || height !== shown.height) {
          shown = { width, height }
          onShown(shown)
        }
      }
      bitmap.close()
    } catch {
      // A frame that fails to decode is simply skipped.
    } finally {
      decoding = false
      const next = pending
      pending = undefined
      if (next && !disposed) void draw(next)
    }
  }

  return {
    draw: (frame) => void draw(frame),
    clear() {
      pending = undefined
      shown = { width: 0, height: 0 }
      surface()?.clearRect(0, 0, canvas.width, canvas.height)
    },
    dispose() {
      disposed = true
      pending = undefined
    },
  }
}
