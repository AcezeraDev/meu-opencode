import fs from "fs/promises"
import path from "path"
import { streamText } from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Global } from "@opencode-ai/core/global"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SessionBudget } from "@/session/budget"

/**
 * Writer: a model chosen for writing (the `writing` role) composes the longer
 * texts the agent has to send, such as an essay or a report in a lesson, or
 * corrects one already written. The agent says what is needed; the writer
 * also sees the page the agent has open, writes, then proofreads its own text
 * in a second pass. The text is saved under an id, and the agent types
 * `@texto:<id>` so the words reach the page exactly as written, without the
 * agent copying them over.
 *
 * The browser tools refuse long prose the agent wrote itself while a writer is
 * set (`guard`): left as a suggestion, the agent kept writing and correcting
 * texts on its own, which is exactly what the writer is there to replace.
 */

export const SYSTEM = `Você é um redator excelente de português do Brasil. Outro assistente, que está preenchendo uma atividade num site, pede um texto e você o escreve.

Regras:
- Entregue SOMENTE o texto final, pronto para colar. Nada de "Claro!", "Aqui está", comentários, notas ou perguntas.
- Siga à risca o que o enunciado pede: tema, perguntas a responder, tópicos, estrutura, tamanho (linhas, palavras, parágrafos) e tom. Responda a cada item pedido, na ordem do enunciado.
- Português correto: ortografia, acentuação, crase, concordância, regência e pontuação revisadas. Nenhuma palavra colada, cortada ou repetida.
- Termos técnicos em inglês só quando são o nome usual da coisa (API, deploy, OAuth); o resto em português.
- Use o material de apoio e a página quando houver; não invente fatos, números, nomes ou fontes que não estejam neles ou que não sejam conhecimento geral seguro. Não afirme que algo foi feito, testado ou medido se o material não disser.
- Se vier um rascunho: corrija todos os erros e melhore a clareza, mas mantenha o conteúdo, a estrutura e o tamanho dele, a menos que o pedido diga outra coisa.
- Se o pedido for corrigir um texto (erros de português, revisar, consertar), corrija o texto existente sem acrescentar ideias, exemplos ou números novos. Quando esse texto aparece na página (um envio atual, uma resposta já salva), a versão da página é a verdadeira: o rascunho pode ter vindo alterado ou incompleto.
- Siglas e termos técnicos não se traduzem palavra por palavra ("data-driven" vira "orientada por dados" só quando soa natural; na dúvida, mantenha o termo).
- Texto simples, sem Markdown (sem #, **, tabelas ou blocos de código), a menos que o formato pedido diga outra coisa. Separe parágrafos com uma linha em branco; listas com "-" ou "1." só quando o enunciado pedir tópicos.
- "Linhas" no enunciado são linhas de texto corrido, não uma frase por linha: um parágrafo é um bloco contínuo.
- Escreva com naturalidade, como uma pessoa que entendeu o assunto, sem enfeites nem frases genéricas.`

export const REVIEW = `Você é um revisor de português do Brasil. Recebe um texto pronto e devolve o mesmo texto revisado.

Corrija apenas: ortografia, acentuação, crase, concordância, regência, pontuação, palavras coladas, cortadas ou repetidas, e frases quebradas. Não mude o conteúdo, a ordem, a estrutura, as quebras de parágrafo nem o tamanho. Não acrescente nada.

Responda SOMENTE com o texto revisado, sem comentários.`

const ROOT = () => path.join(Global.Path.data, "textos")
const REFERENCE = /@texto:([a-z0-9]+)/g
/** Long enough to be prose worth a writer, not a name, a search or a short answer. */
const PROSE_CHARS = 300
const PROSE_WORDS = 45
/** The page's text the writer gets, at most: the assignment and the form, not every menu. */
const PAGE_CHARS = 16000
/** How far the proofread text may differ in length before it is taken for a rewrite and dropped. */
const REVIEW_DRIFT = 0.2

/** The main text of a page: Moodle's main region when there is one, otherwise the body. */
export const PAGE_TEXT = `(() => {
  const main = document.querySelector("#region-main, [role=main], main") || document.body
  return (document.title + "\\n\\n" + (main ? main.innerText : "")).slice(0, ${PAGE_CHARS})
})()`

export function reference(id: string) {
  return `@texto:${id}`
}

interface Model {
  language: LanguageModelV3
  model: Provider.Model
  /** OpenAI's ChatGPT login takes the system prompt as `instructions`, not as a message. */
  instructions?: boolean
  signal?: AbortSignal
}

export async function compose(
  input: Model & {
    request: string
    draft?: string
    material?: string
    format?: string
    page?: { url: string; text: string }
    /** Called as the written text goes to the proofreading pass. */
    onReview?: () => void
  },
) {
  const prompt = [
    `Enunciado / o que o texto precisa ser:\n${input.request}`,
    input.format ? `Formato pedido:\n${input.format}` : undefined,
    input.draft ? `Rascunho para corrigir e melhorar:\n${input.draft}` : undefined,
    input.material ? `Material de apoio:\n${input.material}` : undefined,
    input.page?.text
      ? `Página aberta no navegador (${input.page.url}), para contexto; ignore menus e links:\n${input.page.text}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
  const text = await ask(input, SYSTEM, prompt)
  if (!text) return text
  input.onReview?.()
  // A second, narrow pass catches what slips through while writing. It must
  // not rewrite: an answer far from the original's length is not a revision.
  const revised = await ask(input, REVIEW, text).catch(() => "")
  if (!revised || Math.abs(revised.length - text.length) > text.length * REVIEW_DRIFT) return text
  return revised
}

async function ask(input: Model, system: string, prompt: string) {
  const result = streamText({
    model: input.language,
    messages: input.instructions
      ? [{ role: "user", content: prompt }]
      : [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
    maxOutputTokens: 8000,
    abortSignal: input.signal,
    providerOptions: ProviderTransform.providerOptions(input.model, {
      ...input.model.options,
      ...(input.instructions ? { instructions: system, store: false } : {}),
    }),
    onError: () => {},
  })
  return (await result.text).trim()
}

/** Saves a text and returns its id. */
export async function save(text: string) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await fs.mkdir(ROOT(), { recursive: true })
  await fs.writeFile(path.join(ROOT(), `${id}.txt`), text, "utf8")
  return id
}

/** Replaces every `@texto:<id>` with the saved text; an unknown id is an error the agent can act on. */
export async function expand(text: string) {
  const ids = [...new Set([...text.matchAll(REFERENCE)].map((match) => match[1]))]
  if (ids.length === 0) return text
  const texts = new Map(
    await Promise.all(
      ids.map(async (id) => {
        const saved = await fs.readFile(path.join(ROOT(), `${id}.txt`), "utf8").catch(() => undefined)
        if (saved === undefined) throw new Error(`Não existe texto ${reference(id)}. Gere o texto de novo com write_text.`)
        return [id, saved] as const
      }),
    ),
  )
  return text.replace(REFERENCE, (_, id: string) => texts.get(id) ?? "")
}

/** Whether a text is prose of some length: many words of letters, not a name, a search or a number. */
export function isProse(text: string) {
  const own = text.replace(REFERENCE, "")
  if (own.length < PROSE_CHARS) return false
  return own.split(/\s+/).filter((word) => /\p{L}{2,}/u.test(word)).length >= PROSE_WORDS
}

/**
 * Why a text the agent is about to type has to go through the writer first,
 * or undefined when it may be typed: no writer is set, it is not long prose
 * of the agent's own, or the writer already failed in this request (then the
 * agent's own text is better than none).
 */
export function guard(text: string | undefined, writing: boolean, messages: SessionV1.WithParts[]) {
  if (!writing || !text || !isProse(text)) return undefined
  const last = SessionBudget.toolCalls(messages).findLast((call) => call.tool === "write_text")
  if (last?.state.status === "error") return undefined
  return [
    "Nothing was typed: this long text was written by you, and long texts go through the writing model, which writes better Portuguese.",
    'Call write_text with request = the assignment as the page states it (and what the person asked), plus draft = this text if it should be corrected or reused. Then type the result with text: "@texto:<id>".',
  ].join(" ")
}

export * as Writer from "./writer"
