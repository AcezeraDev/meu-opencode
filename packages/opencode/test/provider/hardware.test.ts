import { describe, expect, test } from "bun:test"
import { Hardware } from "@/provider/hardware"

const machine = (patch: Partial<Hardware.Hardware>): Hardware.Hardware => ({
  platform: "win32",
  release: "10.0.26300",
  cpu: { model: "13th Gen Intel(R) Core(TM) i5-1335U", threads: 12 },
  ramGB: 15.7,
  freeDiskGB: 42.8,
  gpus: [{ name: "Intel(R) Iris(R) Xe Graphics", vendor: "intel", dedicated: false }],
  ...patch,
})

describe("GPU kinds", () => {
  test("integrated graphics are not taken for a card with its own memory", () => {
    expect(Hardware.isDedicated("Intel(R) Iris(R) Xe Graphics")).toBe(false)
    expect(Hardware.isDedicated("AMD Radeon(TM) Graphics")).toBe(false)
    expect(Hardware.isDedicated("Intel(R) Arc(TM) A770 Graphics")).toBe(true)
    expect(Hardware.isDedicated("AMD Radeon RX 7800 XT")).toBe(true)
    expect(Hardware.isDedicated("NVIDIA GeForce RTX 4060 Laptop GPU")).toBe(true)
  })
})

describe("model suggestions", () => {
  test("a 16 GB laptop without a GPU gets the hybrid qwen3.5:4b with 64k context", () => {
    const advice = Hardware.recommend(machine({}), ["qwen3:4b", "qwen3.5:2b", "qwen3.5:4b"])
    expect(advice.accelerator).toBe("cpu")
    expect(advice.budgetGB).toBe(7.9)
    expect(advice.coding).toBe("qwen3.5:4b")
    expect(advice.contextWindow).toBe(65_536)
    expect(advice.fast).toBe("qwen3.5:2b")
    expect(advice.vision).toBe("qwen3.5:4b")
    expect(advice.fits.find((fit) => fit.tag === "qwen3.5:4b")?.installed).toBe(true)
    // 9B does not fit even with 16k in half of 16 GB.
    expect(advice.fits.some((fit) => fit.tag === "qwen3.5:9b")).toBe(false)
    // 8B does not fit next to 16k of context in half of 16 GB.
    expect(advice.fits.some((fit) => fit.tag === "qwen3:8b")).toBe(false)
    expect(advice.notes[0]).toContain("Sem GPU dedicada")
  })

  test("a 12 GB NVIDIA card is used for its own memory, not system RAM", () => {
    const advice = Hardware.recommend(
      machine({ ramGB: 32, gpus: [{ name: "NVIDIA GeForce RTX 3060", vendor: "nvidia", vramGB: 12, dedicated: true }] }),
    )
    expect(advice.accelerator).toBe("cuda")
    expect(advice.budgetGB).toBe(10.8)
    expect(advice.coding).toBe("qwen3.5:9b")
    expect(advice.contextWindow).toBe(65_536)
  })

  test("a big card prefers a model with room for 32k over a bigger one squeezed into 16k", () => {
    const advice = Hardware.recommend(
      machine({ ramGB: 64, gpus: [{ name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", vramGB: 24, dedicated: true }] }),
    )
    expect(advice.coding).toBe("qwen3.5:27b")
    expect(advice.contextWindow).toBe(32_768)
    expect(advice.fits.find((fit) => fit.tag === "qwen3-coder:30b")?.context).toBe(16_384)
  })

  test("too little memory says to use an external model for coding", () => {
    const advice = Hardware.recommend(machine({ ramGB: 4 }))
    expect(advice.coding).toBeUndefined()
    expect(advice.notes.some((note) => note.includes("modelo externo"))).toBe(true)
  })

  test("detect reads this machine without throwing", async () => {
    const found = await Hardware.detect()
    expect(found.cpu.threads).toBeGreaterThan(0)
    expect(found.ramGB).toBeGreaterThan(0)
    expect(Array.isArray(found.gpus)).toBe(true)
  }, 30_000)
})
