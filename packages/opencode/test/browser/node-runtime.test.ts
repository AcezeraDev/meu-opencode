import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

/**
 * The desktop app runs the server under Node, where `Bun` does not exist, but
 * these tests run under Bun, so a `Bun.file` in browser code passes them all
 * and breaks every browser tool in the app. `script/browser-smoke.ts` runs the
 * tools under Node for real; this is the quick check that runs with the rest.
 */
describe("browser code runs under Node", () => {
  test("uses no Bun APIs", async () => {
    const src = path.join(import.meta.dir, "..", "..", "src")
    const files = [
      ...(await fs.readdir(path.join(src, "browser"))).map((name) => path.join(src, "browser", name)),
      ...(await fs.readdir(path.join(src, "tool")))
        .filter((name) => name.startsWith("browser_"))
        .map((name) => path.join(src, "tool", name)),
      path.join(src, "server", "routes", "instance", "httpapi", "handlers", "browser-bridge.ts"),
    ].filter((file) => file.endsWith(".ts"))
    const offending = (
      await Promise.all(
        files.map(async (file) =>
          (await fs.readFile(file, "utf8"))
            .split(/\r?\n/)
            .map((line, index) => ({ line: line.replace(/\/\/.*$/, ""), index }))
            .filter((item) => /\bBun\.[a-zA-Z]/.test(item.line))
            .map((item) => `${path.relative(src, file)}:${item.index + 1}`),
        ),
      )
    ).flat()
    expect(offending).toEqual([])
  })
})
