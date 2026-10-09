import { createSignal } from "solid-js"

/**
 * Whether the browser pane is open, shared by the header toggle, the NAV strip
 * and the session layout.
 *
 * The pane opens by itself when the agent starts browsing, but once the user
 * closes it, it stays closed until the browser shuts down, so an agent working
 * through a long task does not keep pulling it back open.
 *
 * Open, it either docks beside the conversation or floats over it as a small
 * picture-in-picture window; the choice is remembered on this computer.
 */
const FLOAT_KEY = "lynx.browser.floating"
const [opened, setOpened] = createSignal(false)
const [floating, setFloating] = createSignal(read())
let dismissed = false

function read() {
  try {
    return localStorage.getItem(FLOAT_KEY) === "1"
  } catch {
    return false
  }
}

export const browserPane = {
  opened,
  floating,
  setFloating(value: boolean) {
    setFloating(value)
    try {
      localStorage.setItem(FLOAT_KEY, value ? "1" : "0")
    } catch {}
  },
  open() {
    setOpened(true)
  },
  close() {
    dismissed = true
    setOpened(false)
  },
  toggle() {
    if (opened()) browserPane.close()
    else setOpened(true)
  },
  /** The agent started browsing: show it, unless the user closed the pane. */
  reveal() {
    if (!dismissed) setOpened(true)
  },
  /** Steps aside for something else on the stage, without counting as the user closing it. */
  hide() {
    setOpened(false)
  },
  /** The browser shut down: the next time it starts, the pane may open again. */
  rearm() {
    dismissed = false
  },
}
