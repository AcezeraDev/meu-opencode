export * as WebVideoImage from "./image"

export type Size = { width: number; height: number }

const DATA_URL = /^data:image\/[\w.+-]+;base64,/

/** Reads just enough of a base64 data URL to parse the image header. */
function head(dataUrl: string, bytes: number) {
  const match = DATA_URL.exec(dataUrl)
  if (!match) return
  const chars = Math.ceil(bytes / 3) * 4
  const binary = atob(dataUrl.slice(match[0].length, match[0].length + chars))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function png(data: Uint8Array): Size | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (data.length < 24 || signature.some((byte, index) => data[index] !== byte)) return
  const view = new DataView(data.buffer, data.byteOffset)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function gif(data: Uint8Array): Size | undefined {
  if (data.length < 10 || String.fromCharCode(...data.slice(0, 3)) !== "GIF") return
  const view = new DataView(data.buffer, data.byteOffset)
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
}

function webp(data: Uint8Array): Size | undefined {
  if (data.length < 30) return
  if (String.fromCharCode(...data.slice(0, 4)) !== "RIFF" || String.fromCharCode(...data.slice(8, 12)) !== "WEBP")
    return
  const view = new DataView(data.buffer, data.byteOffset)
  const chunk = String.fromCharCode(...data.slice(12, 16))
  if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === "VP8X")
    return {
      width: 1 + (data[24] | (data[25] << 8) | (data[26] << 16)),
      height: 1 + (data[27] | (data[28] << 8) | (data[29] << 16)),
    }
}

function jpeg(data: Uint8Array): Size | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return
  const view = new DataView(data.buffer, data.byteOffset)
  let offset = 2
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return
    const marker = data[offset + 1]
    // Start-of-frame markers carry the dimensions (C4/C8/CC are not frames).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
    offset += 2 + view.getUint16(offset + 2)
  }
}

/**
 * Pixel size of a base64 image data URL (PNG, JPEG, WebP or GIF), or undefined
 * when it can't be determined. JPEG metadata can push the frame header far in,
 * so up to 512 KB of the header is decoded.
 */
export function imageSize(dataUrl: string): Size | undefined {
  try {
    const data = head(dataUrl, 512 * 1024)
    if (!data) return
    const size = png(data) ?? gif(data) ?? webp(data) ?? jpeg(data)
    return size && size.width > 0 && size.height > 0 ? size : undefined
  } catch {
    return
  }
}

function ratio(value: string) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value)
  return match ? Number(match[1]) / Number(match[2]) : undefined
}

/** The "w:h" choice closest to the image's proportions (compared on a log scale). */
export function nearestAspect(options: readonly string[], size: Size) {
  const target = Math.log(size.width / size.height)
  let best: { value: string; distance: number } | undefined
  for (const value of options) {
    const candidate = ratio(value)
    if (candidate === undefined) continue
    const distance = Math.abs(Math.log(candidate) - target)
    if (!best || distance < best.distance) best = { value, distance }
  }
  return best?.value
}
