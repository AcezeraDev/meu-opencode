import { Effect, Schema } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelRoles } from "@/provider/roles"
import { BrowserQA } from "@/browser/qa"
import { VisionEvaluator } from "@/evaluate/vision"
import { SessionBudget } from "@/session/budget"
import * as Tool from "./tool"
import DESCRIPTION from "./visual_review.txt"

export const Parameters = Schema.Struct({
  run: Schema.optional(Schema.String).annotate({ description: "Id of the site check to review (default: the latest)." }),
  focus: Schema.optional(Schema.String).annotate({ description: "Something to look at closely, such as the checkout form." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  run?: string
  status?: string
  score?: number
  issues?: number
  round?: number
  model?: string
}

const ROUNDS = 3

function isModel(value: unknown): value is Provider.Model {
  return typeof value === "object" && value !== null && "capabilities" in value && "providerID" in value
}

export const VisualReviewTool = Tool.define(
  "visual_review",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const report = yield* Effect.promise(() => (params.run ? BrowserQA.load(params.run) : BrowserQA.latest()))
          if (!report) throw new Error("No site check to review: run site_check on the site first.")

          // The vision role if one is set, otherwise the model of this session when it can see images.
          const configured = ModelRoles.pick(cfg, "vision")
          const current = isModel(ctx.extra?.model) ? ctx.extra.model : undefined
          const model = configured
            ? yield* provider.getModel(Provider.parseModel(configured).providerID, Provider.parseModel(configured).modelID)
            : current?.capabilities.input.image
              ? current
              : undefined
          if (!model)
            throw new Error(
              'The current model cannot see images. Set a vision model in opencode.jsonc, e.g. "models": { "vision": "ollama/qwen3.5:4b" }, or use the site_check report alone.',
            )
          const name = `${model.providerID}/${model.id}`
          yield* ctx.metadata({ title: `Avaliando prints de ${report.origin} com ${name}`, metadata: { run: report.id, model: name } })

          const language = yield* provider.getLanguage(model)
          const login = yield* auth.get(model.providerID).pipe(Effect.orElseSucceed(() => undefined))
          const result = yield* Effect.promise(() =>
            VisionEvaluator.review({
              report,
              language,
              model,
              instructions: model.providerID === "openai" && login?.type === "oauth",
              focus: params.focus,
              signal: ctx.abort,
            }),
          )

          // Rounds of this request: earlier visual reviews since the person's last message, plus this one.
          const max = cfg.limits?.max_fix_rounds ?? ROUNDS
          const round = SessionBudget.toolCalls(ctx.messages).filter((call) => call.tool === "visual_review" && call.state.status === "completed").length + 1
          const fix = result.review?.requires_fix ?? false
          const next = !fix
            ? "Aprovado. Mostre o resultado ao usuário."
            : max > 0 && round >= max
              ? `Limite de ${max} rodadas de correção visual atingido nesta tarefa. Não corrija mais: mostre ao usuário o resultado, os prints e os problemas que restam.`
              : `Corrija os problemas high e medium, rode site_check e visual_review de novo (rodada ${round} de ${max || "∞"}).`
          return {
            output: `${VisionEvaluator.render(result, name)}\n\n${next}`,
            title: result.review
              ? `${result.review.status === "approved" ? "Aprovado" : "Precisa de ajustes"} · ${result.review.issues.length} problema(s)`
              : "Avaliação sem formato",
            metadata: {
              run: report.id,
              status: result.review?.status,
              score: result.review?.score,
              issues: result.review?.issues.length,
              round,
              model: name,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
