import os from "os"
import fs from "fs/promises"
import * as Process from "@/util/process"

/**
 * What this machine can run locally, and which Ollama models fit it.
 *
 * Nothing here downloads anything: it reads the hardware and suggests. Sizes
 * are the Q4_K_M downloads of the Ollama library, rounded; check
 * https://ollama.com/library before pulling.
 */

export interface Gpu {
  name: string
  vendor: "nvidia" | "amd" | "intel" | "apple" | "other"
  /** Video memory in GB when it can be read; integrated GPUs share system RAM. */
  vramGB?: number
  dedicated: boolean
}

export interface Hardware {
  platform: NodeJS.Platform
  release: string
  cpu: { model: string; threads: number }
  ramGB: number
  freeDiskGB?: number
  gpus: Gpu[]
}

const GB = 1024 ** 3
const round = (value: number) => Math.round(value * 10) / 10

function vendorOf(name: string): Gpu["vendor"] {
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(name)) return "nvidia"
  if (/amd|radeon/i.test(name)) return "amd"
  if (/intel/i.test(name)) return "intel"
  if (/apple/i.test(name)) return "apple"
  return "other"
}

/** Integrated parts share system RAM: Intel (except Arc A/B cards) and AMD's "Radeon Graphics". */
export function isDedicated(name: string) {
  const vendor = vendorOf(name)
  if (vendor === "nvidia") return true
  if (vendor === "intel") return /arc\(tm\) [ab]\d|arc [ab]\d/i.test(name)
  if (vendor === "amd") return /radeon (rx|pro)|radeon\(tm\) (rx|pro)/i.test(name)
  return false
}

async function text(cmd: string[]) {
  const result = await Process.run(cmd, { nothrow: true, timeout: 8_000 }).catch(() => undefined)
  return result && result.code === 0 ? result.stdout.toString("utf8") : undefined
}

/** NVIDIA cards with their exact memory, when the driver tools are installed. */
async function nvidia(): Promise<Gpu[]> {
  const out = await text(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
  return (out ?? "")
    .split(/\r?\n/)
    .map((line) => line.split(",").map((part) => part.trim()))
    .filter((parts) => parts[0])
    .map(([name, mib]) => ({ name: name!, vendor: "nvidia", vramGB: round(Number(mib) / 1024), dedicated: true }))
}

/**
 * Windows lists every adapter; `AdapterRAM` stops at 4 GB, so the 64-bit size
 * the driver writes to the registry is used when it is there.
 */
async function windows(): Promise<Gpu[]> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$reg = Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*'",
    "Get-CimInstance Win32_VideoController | ForEach-Object { $n = $_.Name; $r = $reg | Where-Object { $_.DriverDesc -eq $n } | Select-Object -First 1; [pscustomobject]@{ name = $n; ram = $_.AdapterRAM; qw = $r.'HardwareInformation.qwMemorySize' } } | ConvertTo-Json -Compress",
  ].join("; ")
  const out = await text(["powershell", "-NoProfile", "-NonInteractive", "-Command", script])
  if (!out?.trim()) return []
  const parsed = (() => {
    try {
      return JSON.parse(out) as unknown
    } catch {
      return undefined
    }
  })()
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  return list.flatMap((item) => {
    if (!item || typeof item !== "object" || typeof (item as { name?: unknown }).name !== "string") return []
    const entry = item as { name: string; ram?: number; qw?: number }
    const bytes = typeof entry.qw === "number" && entry.qw > 0 ? entry.qw : entry.ram
    const dedicated = isDedicated(entry.name)
    return [
      {
        name: entry.name,
        vendor: vendorOf(entry.name),
        // An integrated GPU's figure is a small reserved slice, not what models can use.
        vramGB: dedicated && typeof bytes === "number" && bytes > 0 ? round(bytes / GB) : undefined,
        dedicated,
      },
    ]
  })
}

let cached: Promise<Hardware> | undefined

/** The hardware does not change while the app runs, and asking Windows takes seconds. */
export function detect() {
  cached ??= read(os.homedir())
  return cached
}

async function read(dir: string): Promise<Hardware> {
  const cpus = os.cpus()
  const model = cpus[0]?.model.trim() ?? "desconhecida"
  const fromNvidia = await nvidia()
  const others = process.platform === "win32" ? await windows() : []
  const apple =
    process.platform === "darwin" && /apple/i.test(model)
      ? [{ name: model, vendor: "apple" as const, vramGB: round(os.totalmem() / GB), dedicated: false }]
      : []
  // nvidia-smi knows NVIDIA memory exactly; the Windows list fills in everything else.
  const gpus = [...fromNvidia, ...others.filter((gpu) => gpu.vendor !== "nvidia" || fromNvidia.length === 0), ...apple]
  const disk = await fs.statfs(dir).catch(() => undefined)
  return {
    platform: process.platform,
    release: os.release(),
    cpu: { model, threads: cpus.length },
    ramGB: round(os.totalmem() / GB),
    freeDiskGB: disk ? round((disk.bavail * disk.bsize) / GB) : undefined,
    gpus,
  }
}

export interface Candidate {
  tag: string
  sizeGB: number
  /** Context memory per 1k tokens at fp16, roughly, for this model's architecture. */
  kvGBPer1k: number
  roles: ("coding" | "fast" | "vision" | "reasoning")[]
  tools: boolean
  vision: boolean
  note: string
}

/**
 * A short list of models known to work with tools in Ollama, smallest first.
 *
 * Qwen3.5 (March 2026) is hybrid: only one layer in four keeps a full cache,
 * so long contexts are cheap. Measured on Ollama 0.35 (2026-10-01):
 * qwen3.5:4b takes 3.1 GB at 8k, 3.9 GB at 32k and 4.8 GB at 64k, while
 * qwen3:4b could not even load at 32k on an Intel iGPU (out of memory).
 * The older qwen3 models stay listed, without a role, for who has them.
 */
export const CANDIDATES: Candidate[] = [
  { tag: "qwen3.5:0.8b", sizeGB: 1.0, kvGBPer1k: 0.02, roles: ["fast"], tools: true, vision: true, note: "minúsculo e rápido; bom para o primeiro treino na CPU" },
  { tag: "qwen3:1.7b", sizeGB: 1.4, kvGBPer1k: 0.11, roles: [], tools: true, vision: false, note: "substituído pelo qwen3.5:2b" },
  { tag: "qwen3:4b", sizeGB: 2.5, kvGBPer1k: 0.14, roles: [], tools: true, vision: false, note: "substituído pelo qwen3.5:4b, que gasta muito menos memória com contexto longo" },
  { tag: "qwen3.5:2b", sizeGB: 2.7, kvGBPer1k: 0.03, roles: ["fast"], tools: true, vision: true, note: "rápido para tarefas simples, títulos e resumos; lê imagens" },
  { tag: "qwen3.5:4b", sizeGB: 3.4, kvGBPer1k: 0.03, roles: ["coding", "reasoning", "vision"], tools: true, vision: true, note: "menor modelo bom para agente; lê prints; 64k de contexto em menos de 5 GB" },
  { tag: "qwen3:8b", sizeGB: 5.2, kvGBPer1k: 0.14, roles: [], tools: true, vision: false, note: "substituído pelo qwen3.5:9b" },
  { tag: "qwen3.5:9b", sizeGB: 6.6, kvGBPer1k: 0.05, roles: ["coding", "reasoning", "vision"], tools: true, vision: true, note: "agente mais confiável; precisa de GPU ou 32 GB de RAM" },
  { tag: "qwen3:14b", sizeGB: 9.3, kvGBPer1k: 0.16, roles: ["coding", "reasoning"], tools: true, vision: false, note: "agente confiável, precisa de GPU ou muita RAM" },
  { tag: "qwen3.5:27b", sizeGB: 17, kvGBPer1k: 0.08, roles: ["coding", "reasoning", "vision"], tools: true, vision: true, note: "o melhor da família que roda em casa; precisa de placa com 24 GB" },
  { tag: "qwen3-coder:30b", sizeGB: 19, kvGBPer1k: 0.1, roles: ["coding"], tools: true, vision: false, note: "MoE com ~3B ativos: roda até na CPU se couber na RAM" },
]

export interface Recommendation {
  accelerator: "cuda" | "rocm" | "metal" | "vulkan-or-cpu" | "cpu"
  /** Memory the model and its context may take without starving the system. */
  budgetGB: number
  /** The largest of 16k/32k/64k that fits with the main coding model. */
  contextWindow: number
  coding?: string
  fast?: string
  vision?: string
  fits: { tag: string; context: number; needGB: number; installed: boolean; note: string }[]
  notes: string[]
}

const CONTEXTS = [65_536, 32_768, 16_384]
/** OpenCode's system prompt and tools need about this much before any conversation. */
const MIN_CONTEXT = 16_384

export function recommend(hardware: Hardware, installed: string[] = []): Recommendation {
  const gpu = [...hardware.gpus].filter((item) => item.dedicated && item.vramGB).sort((a, b) => (b.vramGB ?? 0) - (a.vramGB ?? 0))[0]
  const apple = hardware.gpus.find((item) => item.vendor === "apple")
  const accelerator: Recommendation["accelerator"] = gpu
    ? gpu.vendor === "nvidia"
      ? "cuda"
      : gpu.vendor === "amd"
        ? "rocm"
        : "vulkan-or-cpu"
    : apple
      ? "metal"
      : "cpu"
  // A dedicated card holds the whole model; otherwise half the RAM is left to
  // Windows, the app, the browser and the dev server the agent runs.
  const budget = gpu ? gpu.vramGB! * 0.9 : apple ? hardware.ramGB * 0.65 : hardware.ramGB * 0.5
  const need = (candidate: Candidate, context: number) => candidate.sizeGB + (context / 1024) * candidate.kvGBPer1k + 0.5
  const fits = CANDIDATES.flatMap((candidate) => {
    const context = CONTEXTS.find((size) => need(candidate, size) <= budget)
    if (!context) return []
    return [{ tag: candidate.tag, context, needGB: round(need(candidate, context)), installed: installed.includes(candidate.tag), note: candidate.note }]
  })
  // An agent needs room more than size: a model that fits with 32k of context
  // beats a bigger one squeezed into 16k. Then what is already installed (no
  // download), then the largest.
  const roomy = (tag: string) => Number((fits.find((fit) => fit.tag === tag)?.context ?? 0) >= 32_768)
  const best = (role: Candidate["roles"][number]) =>
    CANDIDATES.filter((candidate) => candidate.roles.includes(role) && fits.some((fit) => fit.tag === candidate.tag)).sort(
      (a, b) =>
        roomy(b.tag) - roomy(a.tag) ||
        Number(installed.includes(b.tag)) - Number(installed.includes(a.tag)) ||
        b.sizeGB - a.sizeGB,
    )[0]?.tag
  const coding = best("coding")
  const contextWindow = fits.find((fit) => fit.tag === coding)?.context ?? MIN_CONTEXT
  const notes = [
    accelerator === "cpu"
      ? "Sem GPU dedicada: os modelos rodam na CPU. Espere poucas palavras por segundo e uma primeira resposta lenta (o prompt do opencode tem mais de 10 mil tokens); as seguintes são mais rápidas porque o Ollama reaproveita o início do prompt."
      : undefined,
    accelerator === "vulkan-or-cpu"
      ? "GPU dedicada que não é NVIDIA: o Ollama só a usa com suporte a Vulkan/ROCm; confira com `ollama ps` se o modelo está na GPU."
      : undefined,
    !coding ? "Nenhum modelo com ferramentas cabe com 16k de contexto; use um modelo externo para programar." : undefined,
    hardware.freeDiskGB !== undefined && hardware.freeDiskGB < 20
      ? `Pouco espaço livre (${hardware.freeDiskGB} GB); cada modelo ocupa de 1,5 a 20 GB.`
      : undefined,
    "Modelos locais pequenos erram mais em tarefas longas de agente; para trabalho grande, combine um modelo externo para planejar e um local para tarefas simples.",
  ].filter((note): note is string => note !== undefined)
  return { accelerator, budgetGB: round(budget), contextWindow, coding, fast: best("fast"), vision: best("vision"), fits, notes }
}

export * as Hardware from "./hardware"
