import { Effect, Schema } from "effect"
import { Lessons } from "@/memory/lessons"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"
import DESCRIPTION from "./lessons.txt"

export const Parameters = Schema.Struct({
  search: Schema.optional(Schema.String).annotate({
    description: "Error text or a short description of the problem to look up.",
  }),
  add: Schema.optional(
    Schema.Struct({
      problem: Schema.String.annotate({ description: "The problem as it showed up, with the error text." }),
      solution: Schema.String.annotate({ description: "What fixed it." }),
      cause: Schema.optional(Schema.String).annotate({ description: "Why it happened." }),
      context: Schema.optional(Schema.String).annotate({ description: "Stack, library or situation." }),
      result: Schema.optional(Schema.String).annotate({ description: "How the fix was confirmed." }),
      tags: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "A few keywords." }),
    }),
  ).annotate({ description: "A lesson to save, once the fix is confirmed." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  found?: number
  saved?: string
}

/**
 * The agent's operational memory (`Lessons`). It touches only that store,
 * outside any project, so it needs no permission.
 */
export const LessonsTool = Tool.define(
  "lessons",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const project = (yield* InstanceState.context).directory
          if (params.add) {
            const lesson = yield* Effect.promise(() => Lessons.add({ ...params.add!, tags: params.add!.tags ? [...params.add!.tags] : [], project }))
            return {
              output: `Lição guardada:\n${Lessons.format(lesson)}`,
              title: lesson.problem.slice(0, 80),
              metadata: { saved: lesson.id },
            }
          }
          const query = params.search?.trim()
          if (!query) throw new Error("Pass `search` with the problem to look up, or `add` with a lesson to save.")
          yield* ctx.metadata({ title: query.slice(0, 80), metadata: {} })
          const found = yield* Effect.promise(() => Lessons.search(query, project, 5))
          if (found.length) yield* Effect.promise(() => Lessons.used(found.map((match) => match.lesson.id)))
          return {
            output: found.length
              ? [`Lições parecidas (${found.length}):`, ...found.map((match) => Lessons.format(match.lesson))].join("\n")
              : "Nenhuma lição guardada sobre isso.",
            title: query.slice(0, 80),
            metadata: { found: found.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
