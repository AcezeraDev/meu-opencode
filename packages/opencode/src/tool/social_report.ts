import { Effect, Schema } from "effect"
import { SocialQueue } from "@/social/queue"
import { Writer } from "@/writer/writer"
import * as Tool from "./tool"
import DESCRIPTION from "./social_report.txt"

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The post's id, as given in the task." }),
  status: Schema.Literals(["posted", "failed", "prepared"]).annotate({
    description:
      "posted once the site confirmed the post went out; failed when it could not be posted; prepared when you only wrote the caption ahead of time.",
  }),
  caption: Schema.optional(Schema.String).annotate({
    description: "The caption that was posted, or the one you prepared.",
  }),
  url: Schema.optional(Schema.String).annotate({ description: "Link to the post, when the site showed one." }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Why it failed, in a sentence the person can act on (for example: not signed in to Instagram).",
  }),
  analysis: Schema.optional(Schema.String).annotate({
    description: "With prepared: what the video shows, in one or two sentences in Portuguese.",
  }),
  profile: Schema.optional(Schema.String).annotate({
    description:
      "With prepared, when you read the profile: a short summary of the account (what it posts, tone, language, emojis, usual hashtags, calls to action) to reuse next time.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  status?: SocialQueue.Status
  network?: SocialQueue.Network
}

/**
 * How the social agents tell the posting queue what happened. It touches only
 * that queue, outside any project, so it needs no permission; the registry
 * offers it to the social agents alone.
 */
export const SocialReportTool = Tool.define(
  "social_report",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const post = yield* Effect.promise(() => SocialQueue.get(params.id))
          if (!post) throw new Error(`No post with id ${params.id} in the queue.`)
          // The prep session only writes the caption; the posting session only says how the post went.
          const owner = params.status === "prepared" ? post.prep?.sessionID : post.sessionID
          if (owner && owner !== ctx.sessionID) throw new Error(`Post ${params.id} belongs to another session.`)
          // A caption from write_text comes as its reference; the queue keeps the text itself.
          const caption = params.caption === undefined ? undefined : yield* Effect.promise(() => Writer.expand(params.caption ?? ""))
          if (params.status === "prepared" && !caption?.trim()) throw new Error("Include the caption you prepared.")
          const saved = yield* Effect.promise(() =>
            SocialQueue.report(
              params.id,
              params.status === "prepared"
                ? { status: "prepared", caption, analysis: params.analysis, profile: params.profile }
                : {
                    status: params.status === "posted" ? "posted" : "failed",
                    caption,
                    url: params.url,
                    reason: params.reason,
                  },
            ),
          )
          const done = {
            posted: [`Recorded: ${post.name} posted on ${post.network}.`, "postado"],
            failed: [`Recorded: ${post.name} failed on ${post.network}.`, "falhou"],
            prepared: [`Recorded: the caption for ${post.name} on ${post.network} is ready. Do not post it.`, "legenda pronta"],
          }[params.status]
          return {
            output: done[0],
            title: `${post.network}: ${done[1]}`,
            metadata: { status: saved?.status, network: post.network },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
