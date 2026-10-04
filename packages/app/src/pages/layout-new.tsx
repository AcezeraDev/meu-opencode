import { createEffect, onCleanup, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { Softkeys } from "@/components/softkeys"
import { usePlatform } from "@/context/platform"
import { useLynxPrefs } from "@/context/lynx-prefs"
import { useSettingsHistory } from "@/context/lynx-history"
import "./lynx-global.css"
import { LynxDrop } from "@/components/lynx-drop"
import { LynxSplash } from "@/components/lynx-splash"
import { setV2Toast, ToastRegion } from "@/utils/toast"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  // Applies the chosen chat style and other Lynx looks to the page from the start.
  useLynxPrefs()
  useSettingsHistory()
  // An answer typed in the desktop's corner note goes into the open session's composer and is sent.
  onCleanup(
    platform.onLynxReply?.((text) => {
      const form = document.querySelector<HTMLFormElement>('[data-component="prompt-input-v2"]')
      const editor = form?.querySelector<HTMLElement>('[contenteditable="true"]')
      if (!form || !editor) return
      editor.focus()
      document.execCommand("insertText", false, text)
      requestAnimationFrame(() => form.requestSubmit())
    }) ?? (() => undefined),
  )
  const [state, setState] = createStore({ debugTools: true })

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>
      {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
      <TabsInfoPopup />
      <Softkeys />
      <LynxDrop />
      <LynxSplash />
      <ToastRegion v2 />
    </div>
  )
}
