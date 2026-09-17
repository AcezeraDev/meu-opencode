import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

/** Personal builds (script/personal-desktop) install next to the official app and update from the local checkout. */
export const PERSONAL = import.meta.env.OPENCODE_PERSONAL === true

export const UPDATER_ENABLED = app.isPackaged && (CHANNEL !== "dev" || PERSONAL)
