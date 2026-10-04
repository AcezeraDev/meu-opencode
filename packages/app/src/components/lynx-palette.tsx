import { useTheme } from "@opencode-ai/ui/theme/context"
import { For, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { CHAT_STYLES, HOME_VIEWS, useLynxPrefs, VARIANTS } from "@/context/lynx-prefs"
import type { CommandPaletteEntry } from "./command-palette"

/** What the first character of the search asks for. */
export type PaletteScope = "all" | "commands" | "files" | "sessions" | "ask"

export const PREFIXES: { scope: PaletteScope; char: string }[] = [
  { scope: "all", char: "" },
  { scope: "commands", char: ">" },
  { scope: "files", char: "@" },
  { scope: "sessions", char: "#" },
  { scope: "ask", char: "?" },
]

export function readScope(text: string): { scope: PaletteScope; rest: string } {
  const found = PREFIXES.find((prefix) => prefix.char && text.startsWith(prefix.char))
  return found ? { scope: found.scope, rest: text.slice(1).trimStart() } : { scope: "all", rest: text }
}

export function inScope(entry: CommandPaletteEntry, scope: PaletteScope) {
  if (scope === "commands") return entry.type === "command"
  if (scope === "files") return entry.type === "file"
  if (scope === "sessions") return entry.type === "session"
  return true
}

function fold(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

/**
 * Where each letter of the search was found in the text, in order, so "nvss"
 * lights up N-o-V-a S-e-S-são. Undefined when the letters are not all there.
 */
export function fuzzy(text: string, query: string): number[] | undefined {
  const hay = fold(text)
  const needle = fold(query).replace(/\s+/g, "")
  if (!needle) return []
  const direct = hay.indexOf(needle)
  if (direct >= 0) return Array.from({ length: needle.length }, (_, index) => direct + index)
  const hits: number[] = []
  let from = 0
  for (const char of needle) {
    const at = hay.indexOf(char, from)
    if (at < 0) return undefined
    hits.push(at)
    from = at + 1
  }
  return hits
}

/** The title with the letters that matched lit up, one after another. */
export function Lit(props: { text: string; query: string }): JSX.Element {
  const hits = () => new Set(fuzzy(props.text, props.query) ?? [])
  return (
    <For each={[...props.text]}>
      {(char, index) => (
        <Show when={hits().has(index())} fallback={char}>
          <mark class="lynx-lit" style={{ "--n": String([...hits()].indexOf(index())) }}>
            {char}
          </mark>
        </Show>
      )}
    </For>
  )
}

/**
 * Small sums answered on the spot: "15% de 340", "2+2*3", "quanto é 120/7".
 * Anything else is a question for Lynx in a session.
 */
export function quickAnswer(question: string): string | undefined {
  const text = fold(question)
    .replace(/^(quanto e|quanto da|calcula|calcule|qual e)\s+/, "")
    .replace(/\?+$/, "")
    .trim()
  const percent = text.match(/^([\d.,]+)\s*%\s*(de|of)\s*([\d.,]+)$/)
  const number = (value: string) => Number(value.replace(/\./g, "").replace(",", "."))
  if (percent) return format((number(percent[1]) / 100) * number(percent[3]))
  const expression = text.replace(/x/g, "*").replace(/,/g, ".")
  if (!/^[\d\s+\-*/().]+$/.test(expression) || !/\d/.test(expression)) return undefined
  // Only digits, operators and parentheses reach here, so evaluating cannot run
  // anything else; a half-typed sum ("2+") is simply not an answer yet.
  try {
    const value = Function(`"use strict"; return (${expression})`)() as unknown
    return typeof value === "number" && Number.isFinite(value) ? format(value) : undefined
  } catch {
    return undefined
  }
}

function format(value: number) {
  return Number.isInteger(value) ? value.toLocaleString("pt-BR") : value.toLocaleString("pt-BR", { maximumFractionDigits: 4 })
}

/* ---------- Step-by-step choices (with a card carousel) ---------- */

export type PaletteStep = "style" | "variant" | "home"

export function useLynxSteps() {
  const language = useLanguage()
  const prefs = useLynxPrefs()
  const theme = useTheme()
  const t = (key: string) => language.t(key as never)
  const steps: Record<PaletteStep, { title: string; options: { id: string; label: string; hint?: string; on: boolean; pick: () => void }[] }> = {
    get style() {
      return {
        title: t("lynx.chat.style"),
        options: CHAT_STYLES.map((style) => ({
          id: style,
          label: t(`lynx.chat.style.${style}`),
          hint: t(`lynx.chat.style.${style}.hint`),
          on: prefs.get("chatStyle") === style,
          pick: () => prefs.set("chatStyle", style),
        })),
      }
    },
    get variant() {
      return {
        title: t("lynx.set.variant"),
        options: VARIANTS.map((variant) => ({
          id: variant,
          label: t(`lynx.set.variant.${variant}`),
          on: prefs.get("variant") === variant,
          pick: () => {
            theme.setColorScheme(variant === "dia" ? "light" : "dark")
            prefs.set("variant", variant)
          },
        })),
      }
    },
    get home() {
      return {
        title: t("lynx.set.homeView"),
        options: HOME_VIEWS.map((view) => ({
          id: view,
          label: t(`lynx.home.view.${view}`),
          on: prefs.get("homeView") === view,
          pick: () => prefs.set("homeView", view),
        })),
      }
    },
  }
  return steps
}

/** Entries that open a step of choices, listed with the commands. */
export function stepEntries(steps: ReturnType<typeof useLynxSteps>, category: string): CommandPaletteEntry[] {
  return (Object.keys(steps) as PaletteStep[]).map((step) => ({
    id: `lynx.step.${step}`,
    type: "command",
    title: `${steps[step].title} ›`,
    category,
  }))
}
