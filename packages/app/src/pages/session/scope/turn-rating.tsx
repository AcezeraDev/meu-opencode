import "./scope.css"
import { createMemo, createSignal, For } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export type Rating = "excellent" | "approved" | "rejected"
const RATINGS: Rating[] = ["excellent", "approved", "rejected"]
const MARK: Record<Rating, string> = { excellent: "★", approved: "👍", rejected: "👎" }

/** Reads `metadata.ratings`: the person's verdict on each turn, by its user message id. */
export function ratingsOf(metadata: Record<string, unknown> | undefined): Record<string, Rating> {
  const value = metadata?.["ratings"]
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Rating] => RATINGS.includes(entry[1] as Rating)),
  )
}

/**
 * The person's verdict on a finished turn: excellent, approved or needs work.
 * Kept in the session's metadata, so the server's dataset export can pick the
 * good turns only. Clicking the chosen one again clears it.
 */
export function TurnRating(props: {
  sessionID: string
  userMessageID: string
  metadata: Record<string, unknown> | undefined
  save: (sessionID: string, metadata: Record<string, unknown>) => Promise<unknown>
}) {
  const language = useLanguage()
  // Shows the click right away instead of waiting for the server's session update.
  const [pending, setPending] = createSignal<Rating | null>()
  const current = createMemo(() => {
    const value = pending()
    if (value !== undefined) return value ?? undefined
    return ratingsOf(props.metadata)[props.userMessageID]
  })

  const pick = (rating: Rating) => {
    const next = current() === rating ? null : rating
    setPending(next)
    const ratings = { ...ratingsOf(props.metadata) }
    if (next) ratings[props.userMessageID] = next
    else delete ratings[props.userMessageID]
    props
      .save(props.sessionID, { ...props.metadata, ratings })
      .then(() => setPending(undefined))
      .catch((error: unknown) => {
        setPending(undefined)
        showToast({
          variant: "error",
          title: language.t("session.rating.saveFailed"),
          description: error instanceof Error ? error.message : undefined,
        })
      })
  }

  return (
    <div class="turn-rating" role="group" aria-label={language.t("session.rating.label")}>
      <For each={RATINGS}>
        {(rating) => (
          <button
            type="button"
            class="turn-rating-button"
            data-rating={rating}
            data-active={current() === rating ? "" : undefined}
            aria-pressed={current() === rating}
            title={language.t(`session.rating.${rating}` as Parameters<typeof language.t>[0])}
            onClick={() => pick(rating)}
          >
            <span aria-hidden="true">{MARK[rating]}</span>
            <span class="turn-rating-text">{language.t(`session.rating.${rating}` as Parameters<typeof language.t>[0])}</span>
          </button>
        )}
      </For>
    </div>
  )
}
