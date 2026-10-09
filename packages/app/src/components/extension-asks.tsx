import { onCleanup, onMount } from "solid-js"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { listenExtension } from "@/pages/layout/extension-asks"
import { sendToOpenComposer } from "@/utils/composer-send"

// Both layouts mount the app's providers, and some routes mount them twice; a
// request from the extension must start one conversation, not two.
const state = { running: false }

/** Acts on what the browser extension asks while the app is open. Renders nothing. */
export function ExtensionAsks() {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const server = useServer()
  const layout = useLayout()
  const tabs = useTabs()
  const platform = usePlatform()

  // The project on screen in the sidebar's order; failing that, the latest the server knows.
  const directory = () =>
    layout.projects.list()[0]?.worktree ??
    [...serverSync().data.project]
      .filter((project) => project.worktree !== "/")
      .sort((a, b) => b.time.updated - a.time.updated)[0]?.worktree

  onMount(() => {
    if (state.running) return
    state.running = true
    const stop = listenExtension({
      listen: (cb) => serverSDK().event.listen(cb),
      start: (text) => {
        const dir = directory()
        if (!dir) return
        void tabs.newDraft({ server: server.key, directory: dir }, text, undefined, true)
      },
      follow: sendToOpenComposer,
      abort: (session) => serverSDK().client.session.abort(session),
      reply: (input) =>
        serverSDK().client.permission.reply({ requestID: input.requestID, directory: input.directory, reply: input.reply }),
      open: (session) => {
        tabs.select(tabs.addSessionTab({ server: server.key, sessionId: session.sessionID }))
        platform.showWindow?.()
      },
    })
    onCleanup(() => {
      stop()
      state.running = false
    })
  })

  return null
}
