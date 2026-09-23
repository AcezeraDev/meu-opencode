import { Effect, Schema } from "effect"
import { Browser } from "@/browser/session"
import { BrowserSite } from "@/browser/site"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_notes.txt"

export const Parameters = Schema.Struct({
  add: Schema.optional(Schema.String).annotate({ description: "A note to keep about the site." }),
  remove: Schema.optional(Schema.Array(Schema.Number)).annotate({
    description: "Numbers of notes to delete, as they are listed.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "A page of the site the notes are about. Defaults to the page the browser is on.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

interface Metadata {
  host?: string
  notes: number
}

/**
 * Notes the agent keeps about a site, for the next time it is there. They live
 * with the site's saved programs, outside any project (see `BrowserSite`), and
 * touch nothing but that store, so writing one needs no permission.
 */
export const BrowserNotesTool = Tool.define(
  "browser_notes",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          // Only the tab already open: noting something must never start a browser.
          const tab = params.url ? undefined : yield* browser.current()
          const url = params.url ?? (tab ? yield* Effect.promise(() => tab.url()) : undefined)
          const host = BrowserSite.hostOf(url)
          if (!host) throw new Error("Notes belong to a website: open one in the browser first, or pass its url.")
          yield* ctx.metadata({ title: host, metadata: { host, notes: 0 } })

          const removed = params.remove?.length
            ? yield* Effect.promise(() => BrowserSite.removeNotes(host, params.remove!))
            : undefined
          const notes = params.add?.trim()
            ? yield* Effect.promise(() => BrowserSite.addNote(host, params.add!))
            : (removed ?? (yield* Effect.promise(() => BrowserSite.notes(host))))
          return {
            output: notes.length
              ? [`Notes for ${host}:`, ...notes.map((note, index) => `${index + 1}. ${note.text}`)].join("\n")
              : `No notes for ${host}.`,
            title: host,
            metadata: { host, notes: notes.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
