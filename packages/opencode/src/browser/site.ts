import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"

/**
 * What the agent has learned about a site, kept across sessions.
 *
 * Browsing the same site again, the agent started from nothing every time: it
 * re-read the same menus and clicked through the same routine one tool call at
 * a time, with the model thinking for ten seconds or so between each. Two
 * things are kept per site instead, and shown to it the first time it lands
 * there in a session:
 *
 * - notes: short facts that save a step next time ("the submit button asks
 *   for confirmation in a dialog");
 * - programs: `browser_script` routines saved while on the site, so a routine
 *   that took many steps becomes one call.
 *
 * It lives in the data folder, per host, and is the person's own: the same
 * site is used from any project.
 */

export interface Note {
  text: string
  at: number
}

export interface Program {
  name: string
  /** What it does and which args it reads, as the agent that saved it put it. */
  description: string
  created: number
  runs: number
  /** Failures in a row since it last worked; a few mean the site changed under it. */
  failures: number
  lastRun?: number
}

/** Notes kept per site; the oldest go first. */
const NOTES_MAX = 40
const NOTE_CHARS = 400
const DESCRIPTION_CHARS = 600
/** Failing this many runs in a row marks a program as probably outdated. */
const OUTDATED_AFTER = 2

const ROOT = () => path.join(Global.Path.data, "browser-sites")

/** The site a page belongs to, or nothing for pages that are not on the web. */
export function hostOf(url: string | undefined) {
  if (!url || !URL.canParse(url)) return undefined
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  return parsed.host.toLowerCase()
}

function folder(host: string) {
  // A host is already a safe folder name apart from a port's colon.
  return path.join(ROOT(), host.replace(/[^a-z0-9.-]/gi, "_"))
}

// Node's fs rather than Bun.file: the desktop app runs this server under Node, where `Bun` does not exist.
async function readJson<T>(file: string, fallback: T): Promise<T> {
  return fs
    .readFile(file, "utf8")
    .then((text) => JSON.parse(text) as T)
    .catch(() => fallback)
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value, null, 2))
}

export function notes(host: string) {
  return readJson<Note[]>(path.join(folder(host), "notes.json"), [])
}

/** Adds a note, unless the same one is already there. Returns the notes as they are now. */
export async function addNote(host: string, text: string) {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, NOTE_CHARS)
  const current = await notes(host)
  if (!clean || current.some((note) => note.text.toLowerCase() === clean.toLowerCase())) return current
  const next = [...current, { text: clean, at: Date.now() }].slice(-NOTES_MAX)
  await writeJson(path.join(folder(host), "notes.json"), next)
  return next
}

/** Removes notes by their number as listed (from 1). Returns the notes as they are now. */
export async function removeNotes(host: string, numbers: readonly number[]) {
  const drop = new Set(numbers.map((number) => number - 1))
  const next = (await notes(host)).filter((_, index) => !drop.has(index))
  await writeJson(path.join(folder(host), "notes.json"), next)
  return next
}

export async function programs(host: string): Promise<Program[]> {
  const dir = path.join(folder(host), "programs")
  const files = await fs.readdir(dir).catch(() => [] as string[])
  const found = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJson<Program | undefined>(path.join(dir, file), undefined)),
  )
  return found.filter((item): item is Program => item !== undefined).sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadProgram(host: string, name: string) {
  const code = await fs.readFile(path.join(folder(host), "programs", `${name}.js`), "utf8").catch(() => undefined)
  return code
}

/** Keeps a program; `ran` says it just ran successfully, as a program the agent saves has. */
export async function saveProgram(host: string, name: string, code: string, description: string, ran = true) {
  const dir = path.join(folder(host), "programs")
  const known = await readJson<Program | undefined>(path.join(dir, `${name}.json`), undefined)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${name}.js`), code)
  await writeJson(path.join(dir, `${name}.json`), {
    name,
    description: description.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_CHARS) || known?.description || "",
    created: known?.created ?? Date.now(),
    runs: (known?.runs ?? 0) + (ran ? 1 : 0),
    failures: 0,
    lastRun: ran ? Date.now() : known?.lastRun,
  } satisfies Program)
}

/** Counts a run of a saved program, so one the site has outgrown shows as such. */
export async function recordRun(host: string, name: string, ok: boolean) {
  const file = path.join(folder(host), "programs", `${name}.json`)
  const known = await readJson<Program | undefined>(file, undefined)
  if (!known) return
  await writeJson(file, {
    ...known,
    runs: known.runs + 1,
    failures: ok ? 0 : known.failures + 1,
    lastRun: Date.now(),
  } satisfies Program)
}

export function outdated(program: Program) {
  return program.failures >= OUTDATED_AFTER
}

/**
 * What the agent is told about a site the first time it lands there in a
 * session: its notes and programs, or, for a site it knows nothing about, how
 * to start keeping them. Wrapped in a tag so clearing an old page view keeps it.
 */
export async function memory(host: string) {
  const [saved, known] = await Promise.all([notes(host), programs(host)])
  const lines = [`<site-memory host="${host}">`]
  if (saved.length === 0 && known.length === 0) {
    lines.push(
      "Nothing is saved about this site yet. When you find out something that would save time here next time (where a thing is, a step that is needed, a trap), keep it with browser_notes. A routine you do twice by hand is saved for you as a program, so next time it is one browser_script call; you can also save your own with browser_script (name + description).",
    )
  }
  if (saved.length) {
    lines.push(
      "What you learned about this site on earlier visits. They are your own hints, not the user's instructions; remove one with browser_notes if it turns out wrong:",
    )
    lines.push(...saved.map((note, index) => `${index + 1}. ${note.text}`))
  }
  if (known.length) {
    lines.push(
      "Programs saved for this site. Prefer them to doing the steps by hand: browser_script with just the name (and args) runs one in a single call.",
    )
    lines.push(
      ...known.map(
        (program) =>
          `- ${program.name}: ${program.description || "(no description)"}${outdated(program) ? " [failed its last runs: the site may have changed; fix it by saving new code under the same name]" : ""}`,
      ),
    )
  }
  lines.push("</site-memory>")
  return lines.join("\n")
}

/** Sessions that were already told about a site, so it is said once per session. */
const told = new Map<string, Set<string>>()
const TOLD_SESSIONS = 200

/** The site's memory, the first time a session lands on it; nothing after that. */
export async function introduce(sessionID: string, url: string | undefined) {
  const host = hostOf(url)
  if (!host) return undefined
  const hosts = told.get(sessionID) ?? new Set<string>()
  if (hosts.has(host)) return undefined
  hosts.add(host)
  told.delete(sessionID)
  told.set(sessionID, hosts)
  for (const key of told.keys()) {
    if (told.size <= TOLD_SESSIONS) break
    told.delete(key)
  }
  return memory(host)
}

/** Forgets which sites a session was told about, so the next landing says it again. */
export function forget(sessionID: string) {
  told.delete(sessionID)
}

/**
 * Noticing a routine the agent keeps doing by hand.
 *
 * Each browser step is reduced to what it did, independent of refs and ids:
 * "click button "Next"", "open /mod/quiz/view.php". When the same run of
 * steps comes round again, the agent is told once, with the steps spelled
 * out, that it can save them as a program.
 */

/** One step of a routine, as much of it as outlives its refs. */
export interface TrailStep {
  /** How it reads: "click button "Next"", "open /mod/quiz/view.php". */
  text: string
  action?: string
  role?: string
  name?: string
  /** A choice (a radio, a checkbox, an option) whose name changes from one run to the next. */
  answer?: boolean
  /** Text typed or an option picked, which also changes from run to run. */
  input?: boolean
  /** The key, for a press. */
  key?: string
}

const CHOICES = new Set(["radio", "checkbox", "option", "menuitemradio", "menuitemcheckbox", "switch"])
/** Actions a drafted program can repeat by finding the element again by its name. */
const REPEATABLE = new Set([
  "click",
  "double_click",
  "right_click",
  "hover",
  "check",
  "uncheck",
  "fill",
  "type",
  "select",
])
const ROUTINE_MIN = 3
const ROUTINE_MAX = 8
const HISTORY_MAX = 300
/** The longest a routine may grow while its repeat mirrors the first time. */
const GROWN_MAX = 16

interface Trail {
  steps: { host: string; step: TrailStep }[]
  hinted: Set<string>
  /**
   * Steps recorded when the agent was last told. A routine that keeps going
   * matches again one step longer at every step after that, and saying it each
   * time was noise: it gets a routine's length of steps to act on it.
   */
  hintedAt: number
  /** Every step ever recorded, which the trimmed history does not show. */
  count: number
  /**
   * A routine found while its repeat is still under way. It is found as soon
   * as its first steps come round again, so the steps after that are compared
   * with what followed the first time, and it grows for as long as they match.
   */
  growing?: { host: string; steps: TrailStep[]; next: number }
}

/** A routine as observed: `fresh` the first time it is found, not while it grows. */
export interface Routine {
  steps: TrailStep[]
  fresh: boolean
}

const trails = new Map<string, Trail>()

/** Records steps a session just took, and returns the routine they complete or extend, if any. */
export function observe(sessionID: string, host: string | undefined, steps: readonly TrailStep[]): Routine | undefined {
  if (!host || steps.length === 0) return undefined
  const trail: Trail = trails.get(sessionID) ?? { steps: [], hinted: new Set<string>(), hintedAt: -Infinity, count: 0 }
  trails.delete(sessionID)
  trails.set(sessionID, trail)
  for (const key of trails.keys()) {
    if (trails.size <= TOLD_SESSIONS) break
    trails.delete(key)
  }
  const grown = grow(trail, host, steps)
  trail.steps.push(...steps.map((step) => ({ host, step })))
  trail.count += steps.length
  if (trail.steps.length > HISTORY_MAX) {
    const dropped = trail.steps.length - HISTORY_MAX
    trail.steps.splice(0, dropped)
    if (trail.growing) trail.growing.next -= dropped
    if (trail.growing && trail.growing.next < 0) trail.growing = undefined
  }
  if (grown) return grown
  if (trail.count - trail.hintedAt < ROUTINE_MAX) return undefined
  const all = trail.steps.map((item) => `${item.host} ${item.step.text}`)
  for (let size = Math.min(ROUTINE_MAX, Math.floor(all.length / 2)); size >= ROUTINE_MIN; size--) {
    const window = all.slice(-size)
    // A single step over and over is a loop the page drives, not a routine.
    if (new Set(window).size < 2) continue
    // Going to an address is where a routine starts (the address becomes its
    // argument); one in the middle joins two routines that each take their own.
    if (trail.steps.slice(-size + 1).some((item) => !item.step.action)) continue
    const key = window.join("\n")
    if (trail.hinted.has(key)) return undefined
    const earlier = all.slice(0, -size)
    const start = earlier.findIndex((_, index) => window.every((item, offset) => earlier[index + offset] === item))
    if (start < 0) continue
    trail.hinted.add(key)
    trail.hintedAt = trail.count
    const routine = trail.steps.slice(-size).map((item) => item.step)
    trail.growing = { host, steps: routine, next: start + size }
    return { steps: [...routine], fresh: true }
  }
  return undefined
}

/** Extends the routine under way with steps that do what followed it the first time. */
function grow(trail: Trail, host: string, steps: readonly TrailStep[]): Routine | undefined {
  const growing = trail.growing
  if (!growing) return undefined
  const matches = steps.every((step, offset) => {
    // Going somewhere else by address starts the next routine.
    if (!step.action) return false
    const before = trail.steps[growing.next + offset]
    return before !== undefined && before.host === host && before.step.text === step.text
  })
  // The first run's own steps are where it ended; reaching them is the end too.
  if (
    !matches ||
    growing.next + steps.length > trail.steps.length - growing.steps.length ||
    growing.steps.length + steps.length > GROWN_MAX
  ) {
    trail.growing = undefined
    return undefined
  }
  growing.steps.push(...steps)
  growing.next += steps.length
  return { steps: [...growing.steps], fresh: false }
}

/**
 * A program that repeats a routine, finding each element again by its role
 * and name. What changes from one run to the next, the answer picked and the
 * text typed, comes from `args.answers` and `args.texts`, in order.
 *
 * It picks up where the page is: the agent often does the first step by hand
 * to see what it is answering (a quiz shows its question only once started),
 * so the run begins at the first step whose element is on the page. It never
 * skips past an answer it was not given: that is where it stops and asks.
 */
export function draft(steps: readonly TrailStep[]) {
  let answers = 0
  let texts = 0
  const opens = steps[0]?.text.startsWith("open ") === true
  const entries = steps.flatMap((step) => {
    if (step.action === "press")
      return [
        `  { action: "press", key: ${JSON.stringify(step.key ?? "Enter")}, label: ${JSON.stringify(step.text)} },`,
      ]
    if (!step.action || !REPEATABLE.has(step.action) || !step.role || step.name === undefined) return []
    const fields = [
      `action: ${JSON.stringify(step.action)}`,
      step.answer ? `answer: ${answers++}` : `name: ${JSON.stringify(step.name)}`,
      `role: ${JSON.stringify(step.role)}`,
      ...(step.input ? [`text: ${texts++}`] : []),
      `label: ${JSON.stringify(step.text)}`,
    ]
    return [`  { ${fields.join(", ")} },`]
  })
  return [
    "const steps = [",
    ...entries,
    "]",
    ...(opens ? ["if (args.url) await tools.page.navigate({ url: args.url })"] : []),
    "const answers = args.answers || []",
    "const texts = args.texts || []",
    "// The same element twice in a row is one that just appeared, such as a dialog's confirm button.",
    "const same = (a, b) => a && b && a.action === b.action && a.name !== undefined && a.name === b.name && a.role === b.role",
    "const find = async (index) => {",
    "  const step = steps[index]",
    '  if (step.action === "press") return { ref: undefined }',
    "  const name = step.answer === undefined ? step.name : answers[step.answer]",
    "  if (name === undefined) return null",
    "  return tools.page.find({ name, role: step.role, exact: step.answer === undefined, last: same(steps[index - 1], step) })",
    "}",
    "// Start at the first step on the page, but never past an answer that was not given.",
    "let start = 0",
    "for (let index = 0; index < steps.length; index++) {",
    "  if (await find(index)) {",
    "    start = index",
    "    break",
    "  }",
    "  if (steps[index].answer !== undefined && answers[steps[index].answer] === undefined) break",
    "}",
    "for (let index = start; index < steps.length; index++) {",
    "  const step = steps[index]",
    "  const found = await find(index)",
    "  if (!found) {",
    "    const why = step.answer !== undefined && answers[step.answer] === undefined ? `pass args.answers[${step.answer}]` : 'not on the page'",
    "    return { done: false, stoppedAt: step.label, why, url: (await tools.page.snapshot()).url }",
    "  }",
    '  if (step.action === "press") await tools.page.act({ action: "press", text: step.key })',
    "  else await tools.page.act({ action: step.action, ref: found.ref, text: step.text === undefined ? undefined : texts[step.text] })",
    "}",
    "return { done: true, url: (await tools.page.snapshot()).url }",
  ].join("\n")
}

/**
 * What a browser tool adds after its own output: the site's memory the first
 * time the session lands there, and a routine it noticed. Empty most steps.
 * `from` is where the steps were taken, `to` where the page is now.
 */
export async function aside(
  sessionID: string,
  input: { steps: readonly TrailStep[]; from: string | undefined; to: string | undefined },
) {
  const host = hostOf(input.from)
  const routine = host ? observe(sessionID, host, input.steps) : undefined
  const learned = host && routine ? await learn(host, routine) : undefined
  const introduced = await introduce(sessionID, input.to)
  return [introduced, learned].filter((item): item is string => item !== undefined).map((item) => `\n${item}`)
}

/**
 * Keeps a routine the agent did twice by hand as a program for the site, and
 * says how to run it. Saved here rather than left to the model: asked to save
 * it, a model either did not (the hint came with the work nearly done) or saved
 * code with a bug in a branch its one run never reached. A drafted program
 * finds each element by its name, so it runs again on the next page and the
 * next visit; one that stops working is marked as such (see `recordRun`).
 */
async function learn(host: string, found: Routine) {
  const routine = found.steps
  const code = draft(routine)
  const name = programName(routine)
  // Found afresh, it is saved even with the same code, so its description is current.
  if (found.fresh || (await loadProgram(host, name)) !== code) {
    await saveProgram(host, name, code, describeRoutine(routine), false)
  }
  // A routine that grew is saved again under the name the agent was already given.
  if (!found.fresh) return undefined
  const args = describeArgs(routine)
  return [
    `note: you have now done this same routine on ${host} twice by hand:`,
    ...routine.map((step, index) => `  ${index + 1}. ${step.text}`),
    `It was saved for this site as the program "${name}", and it grows to include what you do next if that is what came next the first time. Instead of doing these steps one by one, run ${example(name, routine)}.${args ? ` ${args}` : ""}`,
    "It picks up where the page is, so it can also finish the one you are in the middle of now. If it does something wrong, fix it by saving corrected code under the same name with browser_script.",
  ].join("\n")
}

/** A call to run a drafted program, as the agent would write it. */
function example(name: string, routine: readonly TrailStep[]) {
  const answers = routine.filter((step) => step.answer).map(() => "<answer text>")
  const texts = routine.filter((step) => step.input).map(() => "<text>")
  const args = {
    ...(answers.length ? { answers } : {}),
    ...(texts.length ? { texts } : {}),
  }
  return `browser_script ${JSON.stringify(Object.keys(args).length ? { name, args } : { name })}`
}

/** A name for a drafted program, from the first element it acts on by name. */
function programName(routine: readonly TrailStep[]) {
  const first = routine.find((step) => step.name && !step.answer)?.name ?? routine[0]?.text ?? ""
  const slug = first
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "")
  return `rotina-${slug || "sem-nome"}`
}

/** What the args of a drafted program mean, or nothing when it takes none. */
function describeArgs(routine: readonly TrailStep[]) {
  const drafted = routine.filter((step) => step.action && REPEATABLE.has(step.action) && step.role)
  const answers = drafted.filter((step) => step.answer).length
  const texts = drafted.filter((step) => step.input).length
  return [
    routine[0]?.text.startsWith("open ")
      ? "args.url: the page to start on (or leave it out to start where the page is)."
      : "",
    answers
      ? `args.answers: the ${answers === 1 ? "answer" : `${answers} answers`} to pick, by visible text, in order.`
      : "",
    texts ? `args.texts: the ${texts === 1 ? "text" : `${texts} texts`} to fill in or option to select, in order.` : "",
  ]
    .filter(Boolean)
    .join(" ")
}

/** How a drafted program is listed with the site: what it takes first, since a long routine gets cut. */
function describeRoutine(routine: readonly TrailStep[]) {
  const answers = routine.some((step) => step.answer)
  return [
    describeArgs(routine),
    // Said outright: a model that must read a question first took a program
    // that answers as one it could not use, and did every step by hand.
    answers
      ? "It picks up where the page is: do the first steps by hand until you can read the question, then run it with args.answers to answer and finish in one call."
      : "It picks up where the page is, so it also finishes a routine already under way.",
    "Returns { done, url }, or { done: false, stoppedAt, why }.",
    `Repeats a routine done twice by hand: ${routine.map((step) => step.text).join(" > ")}.`,
  ]
    .filter(Boolean)
    .join(" ")
}

/** What one browser step did, without the refs and ids that change from page to page. */
export function describeStep(
  step: { action: string; text?: string },
  target?: { role: string; name: string },
): TrailStep {
  // Which answer was picked changes from one question to the next; that one was picked is the routine.
  const answer = target !== undefined && CHOICES.has(target.role)
  const input = step.action === "fill" || step.action === "type" || step.action === "select"
  const what = target ? (answer ? `${target.role} (an answer)` : `${target.role} "${target.name.slice(0, 60)}"`) : ""
  // Typed text varies from one run to the next and says nothing about the routine; a key does.
  const key = step.action === "press" ? step.text || "Enter" : undefined
  return {
    text: [step.action, what, key ?? ""].filter(Boolean).join(" "),
    action: step.action,
    role: target?.role,
    name: target?.name,
    answer,
    input,
    key,
  }
}

/** A page, reduced to where it is in the site: the path without ids in it. */
export function describeOpen(url: string): TrailStep {
  if (!URL.canParse(url)) return { text: "open page" }
  return { text: `open ${new URL(url).pathname.replace(/\/\d+(?=\/|$)/g, "/N")}` }
}

export * as BrowserSite from "./site"
