import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"

/**
 * Operational memory: what the agent learned solving problems (context,
 * problem, cause, solution, result), consulted before similar work. It is not
 * training; it is notes read back into the prompt when they match.
 *
 * One JSON file per lesson in `Global.Path.data/lessons`, like the browser's
 * site notes. Node's fs only: this runs inside the desktop app, which is Node.
 */

export interface Lesson {
  id: string
  created: number
  /** The project folder it came from; lessons from other projects still match, ranked lower. */
  project?: string
  context?: string
  problem: string
  cause?: string
  solution: string
  result?: string
  tags: string[]
  /** How many times it was shown to the agent, and when last. */
  uses: number
  used?: number
}

export type Draft = Pick<Lesson, "problem" | "solution"> & Partial<Pick<Lesson, "context" | "cause" | "result" | "tags" | "project">>

export const dir = () => path.join(Global.Path.data, "lessons")

/** Keys, tokens and passwords never go into memory. */
export function redact(text: string) {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[chave removida]")
    .replace(/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, "[token removido]")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[token removido]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "[chave removida]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[token removido]")
    .replace(/((?:password|senha|secret|token|api[_-]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1[removido]")
}

const clean = (value: string | undefined, max: number) => {
  const text = value === undefined ? undefined : redact(value.trim()).slice(0, max)
  return text ? text : undefined
}

export async function add(draft: Draft): Promise<Lesson> {
  const problem = clean(draft.problem, 600)
  const solution = clean(draft.solution, 1500)
  if (!problem || !solution) throw new Error("A lesson needs a problem and a solution.")
  const lesson: Lesson = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    created: Date.now(),
    project: draft.project,
    context: clean(draft.context, 600),
    problem,
    cause: clean(draft.cause, 600),
    solution,
    result: clean(draft.result, 300),
    tags: (draft.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean).slice(0, 8),
    uses: 0,
  }
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(path.join(dir(), `${lesson.id}.json`), JSON.stringify(lesson, null, 1), "utf8")
  return lesson
}

export async function list(): Promise<Lesson[]> {
  const files = await fs.readdir(dir()).catch(() => [] as string[])
  const read = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) =>
        fs
          .readFile(path.join(dir(), file), "utf8")
          .then((text) => JSON.parse(text) as Lesson)
          .catch(() => undefined),
      ),
  )
  return read.filter((lesson): lesson is Lesson => lesson !== undefined).sort((a, b) => b.created - a.created)
}

export async function remove(id: string) {
  if (!/^[a-z0-9-]+$/.test(id)) return false
  return fs
    .rm(path.join(dir(), `${id}.json`))
    .then(() => true)
    .catch(() => false)
}

const STOP = new Set(
  (
    "the and for with that this from are was were has have not but you your into when what how why use using " +
    "uma um umas uns que com para por como mais mas não nao sem seu sua dos das nos nas ele ela isso esse essa " +
    "este esta foi ser ter tem faz fazer quando onde porque pelo pela aos ate até sobre entre depois antes crie criar"
  ).split(" "),
)

/** Lowercase words without accents, three letters or more, minus common words. */
export function words(text: string) {
  return new Set(
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9_.#+-]+/)
      .map((word) => word.replace(/^[.-]+|[.-]+$/g, ""))
      .filter((word) => word.length >= 3 && !STOP.has(word)),
  )
}

export interface Match {
  lesson: Lesson
  score: number
}

/**
 * Lessons that share rare words with the query, best first. Words in the
 * problem and tags count most; a word that appears in most lessons counts
 * little; the same project adds a bonus.
 */
export function rank(lessons: Lesson[], query: string, project?: string, limit = 3, min = 2): Match[] {
  const asked = words(query)
  if (asked.size === 0) return []
  const fields = lessons.map((lesson) => ({
    lesson,
    strong: words([lesson.problem, lesson.tags.join(" ")].join(" ")),
    weak: words([lesson.context, lesson.cause, lesson.solution].filter(Boolean).join(" ")),
  }))
  const frequency = new Map<string, number>()
  fields.forEach((item) => new Set([...item.strong, ...item.weak]).forEach((word) => frequency.set(word, (frequency.get(word) ?? 0) + 1)))
  const rarity = (word: string) => Math.log(1 + lessons.length / (frequency.get(word) ?? 1))
  return fields
    .map((item) => {
      const hits = [...asked].reduce((sum, word) => {
        if (item.strong.has(word)) return sum + 3 * rarity(word)
        if (item.weak.has(word)) return sum + rarity(word)
        return sum
      }, 0)
      const bonus = hits > 0 && project && item.lesson.project === project ? 1 : 0
      return { lesson: item.lesson, score: hits + bonus }
    })
    .filter((match) => match.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export async function search(query: string, project?: string, limit = 3) {
  return rank(await list(), query, project, limit)
}

/** Counts a lesson as shown, so the ones that keep helping can be told apart later. */
export async function used(ids: string[]) {
  const all = await list()
  await Promise.all(
    all
      .filter((lesson) => ids.includes(lesson.id))
      .map((lesson) =>
        fs.writeFile(
          path.join(dir(), `${lesson.id}.json`),
          JSON.stringify({ ...lesson, uses: lesson.uses + 1, used: Date.now() }, null, 1),
          "utf8",
        ),
      ),
  )
}

export function format(lesson: Lesson) {
  return [
    `- Problema: ${lesson.problem}`,
    lesson.context ? `  Contexto: ${lesson.context}` : undefined,
    lesson.cause ? `  Causa: ${lesson.cause}` : undefined,
    `  Solução: ${lesson.solution}`,
    lesson.result ? `  Resultado: ${lesson.result}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

export * as Lessons from "./lessons"
