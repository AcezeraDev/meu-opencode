import { onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerJson } from "@/utils/server-json"
import {
  NETWORK_NAME,
  frameParts,
  socialPrepTask,
  socialTask,
  startSocialClock,
  type SocialPost,
  type SocialQueue,
} from "@/pages/layout/social-clock"

// Both layouts mount the app's providers, and some routes mount them twice;
// one clock is enough (the server's claim would stop a double post anyway).
const state = { running: false }

/** Runs the posting queue's clock while the app is open. Renders nothing. */
export function SocialClock() {
  const serverSDK = useServerSDK()
  const json = useServerJson()
  const language = useLanguage()

  onMount(() => {
    if (state.running) return
    state.running = true
    const client = (directory: string) => serverSDK().createClient({ directory, throwOnError: true })
    const clock = startSocialClock({
      list: () => json<SocialQueue>("/experimental/social"),
      running: (directory) =>
        client(directory)
          .session.status({ directory })
          .then(
            (result) =>
              new Set(
                Object.entries(result.data ?? {}).flatMap(([id, status]) => (status.type === "idle" ? [] : [id])),
              ),
          )
          .catch(() => undefined),
      create: (directory, post, agent) =>
        client(directory)
          .session.create({
            directory,
            title: `${agent === "social-prep" ? language.t("social.prep.title") : NETWORK_NAME[post.network]}: ${post.name}`,
            agent,
            model: post.model ? { id: post.model.modelID, providerID: post.model.providerID } : undefined,
          })
          .then((result) => result.data?.id)
          .catch(() => undefined),
      claim: (id, sessionID) => json<SocialPost>(`/experimental/social/${id}/claim`, {}, "POST", { sessionID }),
      claimPrep: (id, sessionID) => json<SocialPost>(`/experimental/social/${id}/prepare`, {}, "POST", { sessionID }),
      discard: (directory, sessionID) =>
        client(directory)
          .session.delete({ sessionID, directory })
          .then(() => undefined)
          .catch(() => undefined),
      send: (directory, sessionID, post, profiles) =>
        client(directory)
          .session.promptAsync({
            sessionID,
            directory,
            agent: "social",
            model: post.model,
            // With a caption ready there is nothing to look at: the stills only help write one.
            parts: [
              { type: "text", text: socialTask(post, profiles) },
              ...(post.captionRef ? [] : frameParts(post)),
            ],
          })
          .then(() => undefined),
      sendPrep: (directory, sessionID, post, profiles) =>
        client(directory)
          .session.promptAsync({
            sessionID,
            directory,
            agent: "social-prep",
            model: post.model,
            parts: [{ type: "text", text: socialPrepTask(post, profiles) }, ...frameParts(post)],
          })
          .then(() => undefined),
      fail: (id, reason) =>
        json(`/experimental/social/${id}/report`, {}, "POST", { status: "failed", reason }).then(() => undefined),
      unprepared: (id, reason) =>
        json(`/experimental/social/${id}/report`, {}, "POST", { status: "unprepared", reason }).then(() => undefined),
      text: { stopped: language.t("social.error.stopped"), sendFailed: language.t("social.error.sendFailed") },
    })
    onCleanup(() => {
      clock.stop()
      state.running = false
    })
  })

  return null
}
