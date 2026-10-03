import { Effect, Schema } from "effect"
import { Auth } from "@/auth"
import { Browser } from "@/browser/session"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelRoles } from "@/provider/roles"
import { Writer } from "@/writer/writer"
import * as Tool from "./tool"
import DESCRIPTION from "./write_text.txt"

export const Parameters = Schema.Struct({
  request: Schema.String.annotate({
    description: "What the text must be: the assignment exactly as the page states it, with its questions, topics and size, plus what the person asked.",
  }),
  draft: Schema.optional(Schema.String).annotate({
    description: "An existing text to correct or improve, word for word. Leave out to write from scratch.",
  }),
  material: Schema.optional(Schema.String).annotate({
    description: "Content the text should be based on, such as the lesson text or the class PDF.",
  }),
  format: Schema.optional(Schema.String).annotate({
    description: "Where the text goes and its shape, e.g. Moodle online text field, 15 to 20 lines, three paragraphs.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  id?: string
  model?: string
  words?: number
}

export const WriteTextTool = Tool.define(
  "write_text",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const configured = ModelRoles.pick(cfg, "writing")
          if (!configured)
            throw new Error('No writing model is set. Set one in opencode.jsonc, e.g. "models": { "writing": "openai/gpt-6-luna" }.')
          const parsed = Provider.parseModel(configured)
          const model = yield* provider.getModel(parsed.providerID, parsed.modelID)
          const name = `${model.providerID}/${model.id}`
          yield* ctx.metadata({ title: `Escrevendo o texto com ${name}`, metadata: { model: name } })

          // The writer cannot see the page, so it gets the text of the one open:
          // the assignment, its rubric and what was sent before, whatever the
          // agent remembered to copy.
          const tab = yield* browser.current()
          const page = tab
            ? yield* Effect.promise(() =>
                Promise.all([tab.url(), tab.evaluate<string>(Writer.PAGE_TEXT)]).then(
                  ([url, text]) => ({ url, text: typeof text === "string" ? text : "" }),
                  () => undefined,
                ),
              )
            : undefined

          // The person watching sees the request go to the writer, which otherwise happens off the page.
          const thought = (status: string, short: string, hold = true) =>
            tab?.think({
              short,
              title: `Redator · ${model.name || model.id}`,
              body: params.draft ? `Corrigindo um rascunho: ${params.request}` : params.request,
              status,
              hold,
            })
          void thought("Escrevendo o texto…", `Pedindo o texto ao ${model.name || model.id}`)

          const language = yield* provider.getLanguage(model)
          const login = yield* auth.get(model.providerID).pipe(Effect.orElseSucceed(() => undefined))
          const text = yield* Effect.promise(() =>
            Writer.compose({
              language,
              model,
              instructions: model.providerID === "openai" && login?.type === "oauth",
              request: params.request,
              draft: params.draft,
              material: params.material,
              format: params.format,
              page,
              signal: ctx.abort,
              onReview: () => void thought("Revisando o português…", "Redator revisando o texto"),
            }),
          ).pipe(Effect.onError(() => Effect.sync(() => void thought("O redator parou sem terminar", "Redator parou", false))))
          if (!text) {
            void thought("O redator não devolveu texto", "Redator não devolveu texto", false)
            throw new Error(`The writing model ${name} returned no text. Try again or write a shorter request.`)
          }
          const id = yield* Effect.promise(() => Writer.save(text))
          const words = text.split(/\s+/).filter(Boolean).length
          void thought(`Texto pronto · ${words} palavras`, `Texto pronto · ${words} palavras`, false)
          return {
            title: `Texto pronto · ${words} palavras`,
            output: [
              `Texto escrito e revisado por ${name} (${words} palavras). Para digitar, use text: "${Writer.reference(id)}" no browser_act ou num passo do browser_batch; não redigite nem edite o texto.`,
              `--- texto ${Writer.reference(id)} ---\n${text}\n--- fim ---`,
            ].join("\n\n"),
            metadata: { id, model: name, words },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
