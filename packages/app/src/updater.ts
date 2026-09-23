import type { Accessor } from "solid-js"

/** Where a personal build is (script/personal-desktop/update.ts writes one line per step). */
export type BuildStep = "waiting" | "icons" | "metadata" | "server" | "interface" | "installer"

export type UpdaterState =
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent?: number; step?: BuildStep; started?: number }
  | { status: "ready"; version: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  | { status: "error"; message: string }

export type UpdaterPlatform = {
  /**
   * Personal desktop builds (script/personal-desktop) update by rebuilding from the
   * local checkout: the update button is always shown and "downloading" means compiling.
   */
  personal?: boolean
  state: Accessor<UpdaterState>
  check(): Promise<UpdaterState>
  install(): Promise<void>
}
