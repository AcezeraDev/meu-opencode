import { describe, expect, test } from "bun:test"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"

const rules: PermissionV1.Rule[] = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*.env", action: "ask" },
  { permission: "bash", pattern: "rm *", action: "deny" },
  { permission: "external_directory", pattern: "*", action: "ask" },
]

const action = (mode: Permission.Mode | undefined, permission: string, pattern = "x", ruleset = rules) =>
  Permission.evaluate(permission, pattern, Permission.withMode(ruleset, mode)).action

describe("Permission.mode", () => {
  test("reads a valid mode from session metadata", () => {
    expect(Permission.mode({ permissionMode: "plan" })).toBe("plan")
    expect(Permission.mode({ permissionMode: "nope" })).toBeUndefined()
    expect(Permission.mode(undefined)).toBeUndefined()
  })
})

describe("Permission.withMode", () => {
  test("default leaves the rules alone", () => {
    for (const mode of [undefined, "default"] as const) {
      expect(action(mode, "edit")).toBe("allow")
      expect(action(mode, "read", "a.env")).toBe("ask")
      expect(action(mode, "bash", "rm -rf x")).toBe("deny")
    }
  })

  test("bypass never asks but keeps deny rules", () => {
    expect(action("bypass", "read", "a.env")).toBe("allow")
    expect(action("bypass", "external_directory")).toBe("allow")
    expect(action("bypass", "anything", "x", [])).toBe("allow")
    expect(action("bypass", "bash", "rm -rf x")).toBe("deny")
  })

  test("manual asks before edits and commands, not reads", () => {
    expect(action("manual", "edit")).toBe("ask")
    expect(action("manual", "bash", "ls")).toBe("ask")
    expect(action("manual", "read")).toBe("allow")
    expect(action("manual", "bash", "rm -rf x")).toBe("deny")
  })

  test("accept-edits applies edits without asking", () => {
    const asking: PermissionV1.Rule[] = [{ permission: "*", pattern: "*", action: "ask" }]
    expect(action("accept-edits", "edit", "x", asking)).toBe("allow")
    expect(action("accept-edits", "bash", "ls", asking)).toBe("ask")
    expect(action("accept-edits", "edit", "x", [])).toBe("allow")
    const denied: PermissionV1.Rule[] = [{ permission: "edit", pattern: "*.lock", action: "deny" }]
    expect(action("accept-edits", "edit", "bun.lock", denied)).toBe("deny")
  })

  test("plan refuses edits, asks before commands and hides the edit tools", () => {
    expect(action("plan", "edit")).toBe("deny")
    expect(action("plan", "bash", "ls")).toBe("ask")
    expect(action("plan", "read")).toBe("allow")
    const hidden = Permission.disabled(["edit", "write", "apply_patch", "read", "bash"], Permission.withMode(rules, "plan"))
    expect([...hidden].sort()).toEqual(["apply_patch", "edit", "write"])
  })

  test("a later, more specific rule still wins over the mode's replacement", () => {
    const ruleset: PermissionV1.Rule[] = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "git *", action: "deny" },
    ]
    expect(action("bypass", "bash", "ls", ruleset)).toBe("allow")
    expect(action("bypass", "bash", "git push", ruleset)).toBe("deny")
  })
})
