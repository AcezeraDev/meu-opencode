interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
  /** Personal build that installs next to the official app (see script/personal-desktop). */
  readonly OPENCODE_PERSONAL: boolean
  /** Checkout the personal build was compiled from; its update button rebuilds from here. */
  readonly OPENCODE_PERSONAL_ROOT: string
  /** Bun executable that ran the personal build. */
  readonly OPENCODE_PERSONAL_BUN: string
  /** Newest source modification time included in this build (ms). */
  readonly OPENCODE_PERSONAL_SOURCE_TIME: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export const listen: typeof import("../../../opencode/dist/types/src/node").Server.listen
    export type Listener = import("../../../opencode/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../opencode/dist/types/src/node").Config.get
    export type Info = import("../../../opencode/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../opencode/dist/types/src/node").bootstrap
}
