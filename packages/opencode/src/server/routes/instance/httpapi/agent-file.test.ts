import { describe, expect, test } from "bun:test"
import matter from "gray-matter"
import { serializeAgent, validateAgentMutation } from "./agent-file"

describe("agent file mutation", () => {
  test("accepts only lowercase slug names", () => {
    expect(validateAgentMutation("lesson-helper", [])).toBeUndefined()
    expect(validateAgentMutation("Lesson Helper", [])).toBe("invalid-name")
    expect(validateAgentMutation("../lesson", [])).toBe("invalid-name")
    expect(validateAgentMutation(".lesson", [])).toBe("invalid-name")
  })

  test("keeps the prompt in the markdown body", () => {
    const parsed = matter(
      serializeAgent({
        description: "Answers messages",
        mode: "all",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
        prompt: "Write a concise reply.",
        temperature: 0.4,
        topP: 0.8,
        color: "#336699",
        options: { reasoningEffort: "high" },
        steps: 12,
        permissions: ["read", "websearch", "browser"],
      }),
    )

    expect(parsed.content.trim()).toBe("Write a concise reply.")
    expect(parsed.data.prompt).toBeUndefined()
    expect(parsed.data.model).toBe("openai/gpt-5")
    expect(parsed.data.variant).toBe("high")
    expect(parsed.data.top_p).toBe(0.8)
    expect(parsed.data.options).toEqual({ reasoningEffort: "high" })
    expect(parsed.data.steps).toBe(12)
    expect(parsed.data.permission.read).toBe("allow")
    expect(parsed.data.permission.websearch).toBe("allow")
    expect(parsed.data.permission.bash).toBe("deny")
    expect(parsed.data.permission.browser).toBe("allow")
  })

  test("refuses to overwrite a native agent", () => {
    expect(validateAgentMutation("build", [{ name: "build", native: true }])).toBe("native")
  })
})
