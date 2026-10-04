/**
 * The color the agent's cursor wears in the page: Lynx Code's cyan, the logo
 * color the app's accent always is (ui/src/v2/styles/scope.css), whatever the
 * project.
 *
 * Returned as "r, g, b" so the overlay can mix its own alphas.
 */

const LYNX_CYAN = "34, 211, 238"

export function of() {
  return LYNX_CYAN
}

export * as BrowserAccent from "./accent"
