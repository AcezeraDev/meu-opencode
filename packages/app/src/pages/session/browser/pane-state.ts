import { createSignal } from "solid-js"

/**
 * Whether the browser pane is open, shared by the header toggle, the NAV strip
 * and the session layout.
 *
 * The pane opens by itself when the agent starts browsing, but once the user
 * closes it, it stays closed until the browser shuts down, so an agent working
 * through a long task does not keep pulling it back open.
 */
const [opened, setOpened] = createSignal(false)
let dismissed = false

export const browserPane = {
  opened,
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
  /** The browser shut down: the next time it starts, the pane may open again. */
  rearm() {
    dismissed = false
  },
}
