import fs from "fs/promises"
import path from "path"
import { streamText, type ModelMessage } from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Schema } from "effect"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { BrowserQA } from "@/browser/qa"

/**
 * VisionEvaluator: a model that sees the screenshots of a site check judges
 * the result like a demanding designer would, and answers in a fixed JSON
 * shape. Every issue has to name the element, the screen size and what was
 * seen, so "looks nice" is not an answer.
 */

const Issue = Schema.Struct({
  severity: Schema.optional(Schema.String),
  viewport: Schema.optional(Schema.String),
  page: Schema.optional(Schema.String),
  area: Schema.optional(Schema.String),
  problem: Schema.String,
  fix: Schema.optional(Schema.String),
})

/** What models send: small ones leave fields out, so only `issues` is required and the rest is derived. */
const Answer = Schema.Struct({
  status: Schema.optional(Schema.String),
  score: Schema.optional(Schema.Number),
  issues: Schema.Array(Issue),
  strengths: Schema.optional(Schema.Array(Schema.String)),
  suggestions: Schema.optional(Schema.Array(Schema.String)),
  requires_fix: Schema.optional(Schema.Boolean),
})
const decode = Schema.decodeUnknownOption(Answer)

export interface Review {
  status: "approved" | "needs_changes"
  score?: number
  issues: Schema.Schema.Type<typeof Issue>[]
  strengths: string[]
  suggestions: string[]
  requires_fix: boolean
}

export const SYSTEM = `Você é um avaliador de interfaces exigente. Recebe prints de um site em computador (1366px), tablet (768px) e celular (390px) e os problemas que as medições automáticas acharam.

Avalie: layout, alinhamento, espaçamento, hierarquia visual, tipografia, cores, contraste, consistência entre páginas, responsividade, legibilidade, UX, densidade de conteúdo, menus, botões, cards, tabelas, formulários, estados vazios, overflow, elementos cortados e desalinhados.

Regras:
- Cada problema cita o elemento ("botão Comprar no card de produto"), o tamanho de tela e o que se vê ("o texto quebra em 3 linhas e encosta na borda"). Nada vago como "ficou bonito" ou "poderia melhorar o visual".
- Só aponte o que dá para ver nos prints ou nas medições. Não invente.
- "fix" diz o que mudar no código ou no estilo, de forma concreta.
- severity: "high" quebra o uso ou parece defeito; "medium" atrapalha ou destoa; "low" é polimento.
- status "approved" só se não houver nenhum problema high nem medium. requires_fix = true quando houver high ou medium.

Responda APENAS com este JSON, sem texto fora dele:
{"status":"approved|needs_changes","score":0-10,"issues":[{"severity":"high|medium|low","viewport":"desktop|tablet|mobile|all","page":"/caminho","area":"onde","problem":"o que se vê","fix":"o que mudar"}],"strengths":["..."],"suggestions":["..."],"requires_fix":true}`

/** At most six pictures: every size of the first page, then the desktop of the others. */
export function chooseShots(report: BrowserQA.Report, max = 6) {
  const first = report.shots.filter((shot) => shot.page === report.pages[0])
  const rest = report.shots.filter((shot) => shot.page !== report.pages[0] && shot.viewport === "desktop")
  return [...first, ...rest].slice(0, max)
}

/** The first JSON object in a model's answer, tolerating ```json fences and text around it. */
export function parse(text: string): Review | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  const value = (() => {
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown
    } catch {
      return undefined
    }
  })()
  const result = decode(value)
  if (result._tag === "None") return undefined
  const answer = result.value
  // The rule the model was given decides, whatever it wrote: serious issues mean changes.
  const serious = answer.issues.some((issue) => issue.severity === "high" || issue.severity === "medium")
  const fix = serious || answer.requires_fix === true || answer.status === "needs_changes"
  return {
    status: fix ? "needs_changes" : "approved",
    score: answer.score,
    issues: [...answer.issues],
    strengths: [...(answer.strengths ?? [])],
    suggestions: [...(answer.suggestions ?? [])],
    requires_fix: fix,
  }
}

export async function review(input: {
  report: BrowserQA.Report
  language: LanguageModelV3
  model: Provider.Model
  /** OpenAI's ChatGPT login takes the system prompt as `instructions`, not as a message. */
  instructions?: boolean
  focus?: string
  signal?: AbortSignal
}): Promise<{ review?: Review; raw: string; shots: BrowserQA.Shot[] }> {
  const shots = chooseShots(input.report)
  const images = await Promise.all(shots.map((shot) => fs.readFile(shot.file)))
  const findings = input.report.issues.length
    ? input.report.issues
        .slice(0, 40)
        .map((issue) => `- [${issue.severity}/${issue.kind}] (${issue.viewport ?? "todas"}) ${new URL(issue.page).pathname}: ${issue.message}`)
        .join("\n")
    : "(nenhum)"
  const user: ModelMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          `Site: ${input.report.origin}. Páginas: ${input.report.pages.map((page) => new URL(page).pathname).join(", ")}.`,
          `Problemas medidos automaticamente:\n${findings}`,
          input.focus ? `Foco pedido: ${input.focus}` : undefined,
          `Prints, na ordem: ${shots.map((shot) => `${new URL(shot.page).pathname} em ${shot.viewport}`).join("; ")}.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      ...images.map((image) => ({ type: "image" as const, image, mediaType: "image/jpeg" })),
    ],
  }
  const result = streamText({
    model: input.language,
    messages: input.instructions ? [user] : [{ role: "system", content: SYSTEM }, user],
    temperature: 0.2,
    maxOutputTokens: 3000,
    abortSignal: input.signal,
    providerOptions: ProviderTransform.providerOptions(input.model, {
      ...input.model.options,
      ...(input.instructions ? { instructions: SYSTEM, store: false } : {}),
    }),
    onError: () => {},
  })
  const raw = await result.text
  const parsed = parse(raw)
  await fs.writeFile(
    path.join(path.dirname(shots[0]?.file ?? BrowserQA.root()), "review.json"),
    JSON.stringify({ model: `${input.model.providerID}/${input.model.id}`, time: Date.now(), review: parsed, raw }, null, 1),
    "utf8",
  )
  return { review: parsed, raw, shots }
}

export function render(result: { review?: Review; raw: string }, model: string) {
  const review = result.review
  if (!review) return `O modelo ${model} não respondeu no formato combinado. Resposta bruta:\n${result.raw.slice(0, 4000)}`
  const issue = (item: Review["issues"][number]) =>
    `- [${item.severity ?? "?"}] (${item.viewport ?? "?"}) ${item.page ?? ""} ${item.area ? `${item.area}: ` : ""}${item.problem}${item.fix ? ` → ${item.fix}` : ""}`
  return [
    `Avaliação visual (${model}): ${review.status === "approved" ? "APROVADO" : "PRECISA DE AJUSTES"}${review.score !== undefined ? `, nota ${review.score}/10` : ""}.`,
    review.issues.length ? `Problemas:\n${review.issues.map(issue).join("\n")}` : "Sem problemas apontados.",
    review.strengths.length ? `Pontos fortes:\n${review.strengths.map((item) => `- ${item}`).join("\n")}` : undefined,
    review.suggestions.length ? `Sugestões:\n${review.suggestions.map((item) => `- ${item}`).join("\n")}` : undefined,
    `JSON: ${JSON.stringify(review)}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export * as VisionEvaluator from "./vision"
