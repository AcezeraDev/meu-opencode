import { describe, expect, test } from "bun:test"
import { getProjectAvatarVariant, projectSpace } from "./project-space"

describe("project space color", () => {
  test("a color picked for the project wins", () => {
    expect(getProjectAvatarVariant("orange", "C:/work/site")).toBe("orange")
    expect(getProjectAvatarVariant("mint", "C:/work/site")).toBe("cyan")
  })

  test("one folder spelled differently lands on the same color", () => {
    const color = getProjectAvatarVariant(undefined, "C:/Users/me/site")
    expect(getProjectAvatarVariant(undefined, "C:\\Users\\me\\site\\")).toBe(color)
    expect(getProjectAvatarVariant(undefined, "c:/users/me/site/")).toBe(color)
    expect(color).not.toBe("gray")
  })

  test("a project without a color still gets a space, and a folder alone too", () => {
    expect(projectSpace({ worktree: "/home/me/app" })).toBe(projectSpace(undefined, "/home/me/app"))
    expect(getProjectAvatarVariant(undefined, undefined)).toBe("gray")
  })
})
