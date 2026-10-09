import { describe, expect, test } from "bun:test"
import { BrowserLook } from "../../src/browser/look"

describe("BrowserLook", () => {
  test("lets reading through", () => {
    for (const action of ["goto", "new_tab", "scroll", "hover", "wait_for", "script"])
      expect(BrowserLook.blocks("browser", action)).toBe(false)
  })

  test("refuses anything that acts on the page", () => {
    for (const action of ["click", "double_click", "fill", "type", "press", "select", "check", "drag", "upload_file"])
      expect(BrowserLook.blocks("browser", action)).toBe(true)
    expect(BrowserLook.blocks("browser_evaluate", undefined)).toBe(true)
  })

  test("leaves other permissions alone", () => {
    expect(BrowserLook.blocks("bash", "click")).toBe(false)
    expect(BrowserLook.blocks("edit", undefined)).toBe(false)
  })

  test("reads the session flag", () => {
    expect(BrowserLook.active({ browserLook: true })).toBe(true)
    expect(BrowserLook.active({ browserLook: "yes" })).toBe(false)
    expect(BrowserLook.active(undefined)).toBe(false)
  })
})
