/**
 * Draws every Lynx Code icon from the two marks in `branding/`: the app's
 * Windows icons (packages/desktop/icons/personal, copied in by copy-icons.ts on
 * personal builds), the web app's favicons and the browser extension's icons.
 *
 *   bun script/personal-desktop/brand-icons.ts
 */
import path from "node:path"
import { readdir, mkdir, cp } from "node:fs/promises"

const ROOT = path.resolve(import.meta.dir, "../..")
// sharp is only installed as a dependency of other tools, so it is not hoisted
// where a script can import it by name; load it from Bun's store instead.
const [sharpDir] = await Array.fromAsync(
  new Bun.Glob("node_modules/.bun/sharp@*/node_modules/sharp").scan({ cwd: ROOT, onlyFiles: false, dot: true }),
)
if (!sharpDir) throw new Error("sharp não está instalado; rode bun install.")
const { default: sharp } = await import(path.join(ROOT, sharpDir))
const APP_MARK = path.join(ROOT, "branding", "lynx-code.svg")
const BROWSER_MARK = path.join(ROOT, "branding", "lynx-browser.svg")

const png = (svg: string, size: number) => sharp(svg, { density: Math.max(72, (72 * size) / 64) }).resize(size, size).png().toBuffer()

/** An .ico with one PNG per size (Windows Vista and later read PNG entries). */
async function ico(svg: string, sizes: number[]) {
  const images = await Promise.all(sizes.map((size) => png(svg, size)))
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  images.reduce((offset, image, i) => {
    const entry = 6 + 16 * i
    header.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], entry)
    header.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(image.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    return offset + image.length
  }, header.length)
  return Buffer.concat([header, ...images])
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

// Desktop: same files as icons/dev, redrawn at each file's own size. The .icns
// (macOS only) and the mobile folders are kept from dev.
const desktop = path.join(ROOT, "packages", "desktop", "icons")
await cp(path.join(desktop, "dev"), path.join(desktop, "personal"), { recursive: true })
for (const file of await readdir(path.join(desktop, "personal"))) {
  const target = path.join(desktop, "personal", file)
  if (file.endsWith(".png")) {
    const meta = await sharp(target).metadata()
    await Bun.write(target, await png(APP_MARK, meta.width ?? 512))
  }
  if (file.endsWith(".ico")) await Bun.write(target, await ico(APP_MARK, ICO_SIZES))
}

// Web app favicons, in both places they are served from.
for (const dir of [path.join(ROOT, "packages", "ui", "src", "assets", "favicon"), path.join(ROOT, "packages", "app", "public")]) {
  for (const file of await readdir(dir)) {
    const target = path.join(dir, file)
    if (/^(favicon-96x96|apple-touch-icon|web-app-manifest).*\.png$/.test(file)) {
      const meta = await sharp(target).metadata()
      await Bun.write(target, await png(APP_MARK, meta.width ?? 192))
    }
    if (/^favicon.*\.ico$/.test(file)) await Bun.write(target, await ico(APP_MARK, [16, 32, 48]))
    if (/^favicon.*\.svg$/.test(file)) await Bun.write(target, await Bun.file(APP_MARK).text())
  }
}

// Browser extension.
const extension = path.join(ROOT, "browser-extension", "icons")
await mkdir(extension, { recursive: true })
for (const size of [16, 32, 48, 128]) await Bun.write(path.join(extension, `icon-${size}.png`), await png(BROWSER_MARK, size))

console.log("Ícones do Lynx Code gerados.")
