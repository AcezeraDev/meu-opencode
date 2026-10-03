import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { Tab } from "./tab"

/**
 * The person's study notebook: every time the agent answers a question on a
 * page with "explain each answer" on, what it answered and why is kept here,
 * by subject, so a bimester's lessons can be read back before a test.
 *
 * One JSON file per subject under `Global.Path.data/notebook`. The subject is
 * read from the page's breadcrumb (Moodle and most course sites have one),
 * else its title, else its site.
 */

export type Entry = {
  time: number
  sessionID: string
  /** Where on the course the question was, below the subject: week, lesson. */
  place: string
  /** The activity's heading, such as "Pause e Responda (S19A1a)". */
  activity: string
  answer: string
  why: string
  url: string
}

export type Subject = { slug: string; subject: string; count: number; updated: number }

type Page = { subject: string; place: string; activity: string; url: string }

const root = () => path.join(Global.Path.data, "notebook")
let writing = Promise.resolve()

/** What the page says about where it is, read before the step changes it. */
export async function page(tab: Tab): Promise<Page | undefined> {
  const read = await tab
    .evaluate<{ crumbs: string[]; heading: string; title: string; url: string }>(PAGE_CONTEXT)
    .catch(() => undefined)
  if (!read) return undefined
  const crumbs = read.crumbs.filter((crumb) => !GENERIC.test(crumb))
  const title = read.title.split(/\s[|–-]\s/)[0]?.trim() ?? ""
  const subject = crumbs[0] || title || hostOf(read.url)
  return {
    subject,
    place: crumbs.slice(1, -1).join(" › "),
    activity: read.heading || crumbs.at(-1) || title,
    url: read.url,
  }
}

/** Keeps one explained answer. Never fails the step it came from; the promise is for tests. */
export function add(where: Page | undefined, entry: { sessionID: string; answer: string; why: string }) {
  const why = entry.why.trim()
  if (!where || !why) return writing
  writing = writing
    .then(async () => {
      const file = path.join(root(), `${slug(where.subject)}.json`)
      const saved = await read(file)
      saved.entries.push({
        time: Date.now(),
        sessionID: entry.sessionID,
        place: where.place,
        activity: where.activity,
        answer: entry.answer.trim(),
        why,
        url: where.url,
      })
      await fs.mkdir(root(), { recursive: true })
      await fs.writeFile(file, JSON.stringify({ subject: where.subject, entries: saved.entries }, null, 2))
    })
    .catch(() => {})
  return writing
}

export async function list(): Promise<Subject[]> {
  const names = await fs.readdir(root()).catch(() => [] as string[])
  const subjects = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const saved = await read(path.join(root(), name))
        return {
          slug: name.slice(0, -".json".length),
          subject: saved.subject,
          count: saved.entries.length,
          updated: Math.max(0, ...saved.entries.map((entry) => entry.time)),
        }
      }),
  )
  return subjects.filter((item) => item.count > 0).sort((a, b) => b.updated - a.updated)
}

export async function entries(name: string) {
  if (!/^[\w-]+$/.test(name)) return undefined
  const saved = await read(path.join(root(), `${name}.json`))
  return saved.entries.length ? saved : undefined
}

/** How many answers were explained since a time, for the weekly summary. */
export async function countSince(since: number) {
  const names = await fs.readdir(root()).catch(() => [] as string[])
  const counts = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => (await read(path.join(root(), name))).entries.filter((entry) => entry.time >= since).length),
  )
  return counts.reduce((total, count) => total + count, 0)
}

async function read(file: string): Promise<{ subject: string; entries: Entry[] }> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (!text) return { subject: "", entries: [] }
  try {
    const value = JSON.parse(text)
    return { subject: String(value.subject ?? ""), entries: Array.isArray(value.entries) ? value.entries : [] }
  } catch {
    return { subject: "", entries: [] }
  }
}

function slug(text: string) {
  const base = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
  return base || "geral"
}

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Breadcrumb items that name no subject. */
const GENERIC = /^(p[áa]gina inicial|in[íi]cio|home|painel|dashboard|meus cursos|my courses|cursos|courses)$/i

const PAGE_CONTEXT = `(() => {
  const crumbs = [...document.querySelectorAll('.breadcrumb li, nav[aria-label*="readcrumb" i] li, [class*="breadcrumb" i] li')]
    .map((item) => (item.textContent || "").replace(/\\s+/g, " ").trim())
    .filter(Boolean)
  const heading = (document.querySelector("h1") || document.querySelector("h2"))?.textContent?.replace(/\\s+/g, " ").trim() || ""
  return { crumbs: [...new Set(crumbs)], heading, title: document.title || "", url: location.href }
})()`

export * as BrowserNotebook from "./notebook"
