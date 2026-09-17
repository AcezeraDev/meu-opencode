import type { ElectronAPI } from "../preload/types"

declare global {
  interface ImportMetaEnv {
    /** Set for personal builds (script/personal-desktop), which update from the local checkout. */
    readonly VITE_OPENCODE_PERSONAL?: boolean
  }

  interface Window {
    api: ElectronAPI
    __OPENCODE__?: {
      deepLinks?: string[]
    }
  }
}
