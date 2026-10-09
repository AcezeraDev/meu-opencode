/**
 * The color the agent's cursor wears in the page: Lynx Code's coral, the logo
 * color the app's accent always is (ui/src/v2/styles/scope.css), whatever the
 * project.
 *
 * Returned as "r, g, b" so the overlay can mix its own alphas.
 */

const LYNX_CORAL = "255, 107, 91"

export function of() {
  return LYNX_CORAL
}

export * as BrowserAccent from "./accent"
