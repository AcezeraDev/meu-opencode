import { Effect } from "effect"
import { streamText } from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { Auth } from "@/auth"
import type { Config } from "@/config/config"
import type { Tab } from "@/browser/tab"
import { Provider } from "@/provider/provider"
import { ModelRoles } from "@/provider/roles"
import { ProviderTransform } from "@/provider/transform"
import { Writer } from "@/writer/writer"

/**
 * Checker: before the agent presses the button that sends a lesson ("Salvar
 * mudanças", "Enviar", "Verificar"), the model chosen for checking (the
 * `evaluation` role) reads the assignment and the answers on the page. When it
 * finds a clear mistake the click does not happen and the agent gets the list
 * to fix; after `ROUNDS` refusals on the same page the click goes through, so a
 * strict or mistaken checker cannot hold a lesson back forever.
 */

export const SYSTEM = `Você confere atividades escolares antes de serem enviadas. Outro assistente preencheu a atividade num site e vai clicar em enviar.

Você recebe o enunciado da página e as respostas preenchidas. Responda assim:
- Primeira linha: APROVADO ou CORRIGIR.
- Se CORRIGIR: até 5 linhas curtas começando com "- ", cada uma dizendo o problema e o que fazer.

Peça correção só por erro claro: resposta errada numa questão objetiva, pergunta do enunciado sem resposta, campo obrigatório vazio, texto que não responde ao que foi pedido, tamanho muito fora do pedido, ou erros de português que um professor descontaria. Na dúvida, aprove. Não peça melhorias de estilo.`

/** The names of buttons that send a lesson in Moodle, H5P and the like. */
const SUBMIT =
  /^(salvar mudanças|salvar e enviar|enviar|enviar tudo e terminar|enviar para avaliação|enviar tarefa|verificar|finalizar tentativa|concluir|submit|submit all and finish|check|save changes)$/i
/** Refusals on one page before the click is let through anyway. */
const ROUNDS = 2
const CONTEXT_CHARS = 12000

const refused = new Map<string, number>()

/**
 * What a send button's form holds: its text, for the questions, and every
 * answer given in it, including the ones the text does not show (a checked
 * option, an editor inside a frame).
 */
const ANSWERS = (locate: string) => `(() => {
  const el = ${locate}
  if (!el) return null
  const scope = el.closest("form") || el.ownerDocument.body
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim()
  const labelOf = (field) => clean((field.labels && field.labels[0] && field.labels[0].innerText) || field.getAttribute("aria-label") || field.closest("label")?.innerText || field.value)
  const answers = []
  for (const field of scope.querySelectorAll("input, textarea, select")) {
    const type = (field.getAttribute("type") || "").toLowerCase()
    if (/^(hidden|submit|button|reset|image|file|password)$/.test(type)) continue
    if (type === "radio" || type === "checkbox") {
      if (field.checked) answers.push("Marcado: " + labelOf(field))
      continue
    }
    if (field.tagName === "SELECT") {
      const option = field.selectedOptions[0]
      if (option && clean(option.text)) answers.push(labelOf(field) + ": " + clean(option.text))
      continue
    }
    if (field.getClientRects().length && clean(field.value)) answers.push((labelOf(field) || "Campo") + ": " + field.value.trim())
  }
  const editors = [...scope.querySelectorAll('[contenteditable=""], [contenteditable="true"]')]
  for (const frame of scope.querySelectorAll("iframe")) {
    try {
      const body = frame.contentDocument && frame.contentDocument.body
      if (body && body.isContentEditable) editors.push(body)
    } catch (error) {}
  }
  for (const editor of editors) if (clean(editor.innerText)) answers.push("Texto: " + editor.innerText.trim())
  return { form: clean(scope.innerText).slice(0, ${CONTEXT_CHARS}), answers }
})()`

/** Whether a click on this element sends a lesson. */
export function sends(name: string | undefined) {
  return !!name && SUBMIT.test(name.trim())
}

/**
 * Reviews a lesson before its send button is clicked. Returns a refusal for
 * the agent, or undefined when the click may go ahead: no checking model is
 * set, the button does not send anything, nothing was answered, the checker
 * approved, or it already refused this page `ROUNDS` times.
 */
export const gate = Effect.fn("Checker.gate")(function* (input: {
  tab: Tab
  ref: string | undefined
  action: string
  sessionID: string
  signal: AbortSignal
  config: Config.Interface
  provider: Provider.Interface
  auth: Auth.Interface
}) {
  if (input.action !== "click" || !input.ref) return undefined
  const configured = ModelRoles.pick(yield* input.config.get(), "evaluation")
  const ref = input.ref.startsWith("ref_") ? input.ref : `ref_${input.ref}`
  if (!configured || !sends(input.tab.identityOf(ref)?.name)) return undefined

  const tab = input.tab
  const url = yield* Effect.promise(() => tab.url())
  const key = `${input.sessionID} ${url}`
  if ((refused.get(key) ?? 0) >= ROUNDS) return undefined
  const page = yield* Effect.promise(() =>
    Promise.all([
      tab.evaluate<string>(Writer.PAGE_TEXT),
      tab.evaluate<{ form: string; answers: string[] } | null>(ANSWERS(tab.locate(`[data-oc-ref="${ref}"]`))),
    ]).catch(() => undefined),
  )
  if (!page?.[1] || page[1].answers.length === 0) return undefined

  const parsed = Provider.parseModel(configured)
  const model = yield* input.provider.getModel(parsed.providerID, parsed.modelID)
  const language = yield* input.provider.getLanguage(model)
  const login = yield* input.auth.get(model.providerID).pipe(Effect.orElseSucceed(() => undefined))
  const name = model.name || model.id
  void tab.think({ short: `Conferindo com ${name}`, title: `Conferência · ${name}`, status: "Conferindo a lição antes de enviar…", hold: true })
  const verdict = yield* Effect.promise(() =>
    review({
      language,
      model,
      instructions: model.providerID === "openai" && login?.type === "oauth",
      signal: input.signal,
      prompt: [
        `Página (${url}):\n${page[0] ?? ""}`,
        `Formulário que vai ser enviado:\n${page[1]!.form}`,
        `Respostas preenchidas:\n${page[1]!.answers.join("\n")}`,
      ].join("\n\n"),
    }).catch(() => undefined),
  )
  // A checker that fails or answers out of format never blocks the lesson.
  if (!verdict || !/^\s*CORRIGIR/i.test(verdict)) {
    void tab.think({ short: "Lição conferida", title: `Conferência · ${name}`, status: "Aprovada", hold: false })
    return undefined
  }
  refused.set(key, (refused.get(key) ?? 0) + 1)
  void tab.think({ short: "Conferência pediu correções", title: `Conferência · ${name}`, body: verdict, status: "Precisa corrigir", hold: false })
  const problems = verdict.replace(/^\s*CORRIGIR\s*/i, "").trim()
  return [
    `Not sent: the checking model (${model.providerID}/${model.id}) read the lesson before the click and found problems:`,
    problems,
    "Fix them on the page (long texts again through write_text, with the current text as draft), then click the send button again.",
  ].join("\n")
})

async function review(input: {
  language: LanguageModelV3
  model: Provider.Model
  instructions: boolean
  signal: AbortSignal
  prompt: string
}) {
  const result = streamText({
    model: input.language,
    messages: input.instructions
      ? [{ role: "user", content: input.prompt }]
      : [
          { role: "system", content: SYSTEM },
          { role: "user", content: input.prompt },
        ],
    maxOutputTokens: 4000,
    abortSignal: input.signal,
    providerOptions: ProviderTransform.providerOptions(input.model, {
      ...input.model.options,
      ...(input.instructions ? { instructions: SYSTEM, store: false } : {}),
    }),
    onError: () => {},
  })
  return (await result.text).trim()
}

export * as Checker from "./checker"
